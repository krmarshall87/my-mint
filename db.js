// Storage layer. Uses Postgres when DATABASE_URL is set, otherwise a local JSON
// file (handy for development; Render's filesystem is ephemeral, so use Postgres there).
const fs = require('fs');
const path = require('path');

function txFromPlaid(t, itemId) {
  const pfc = t.personal_finance_category || {};
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    item_id: itemId,
    date: t.date,
    authorized_date: t.authorized_date || null,
    name: t.name,
    merchant_name: t.merchant_name || null,
    amount: t.amount,
    iso_currency_code: t.iso_currency_code || t.unofficial_currency_code || null,
    category: pfc.primary || (t.category && t.category[0]) || null,
    category_detailed: pfc.detailed || null,
    pending: !!t.pending,
    payment_channel: t.payment_channel || null,
    logo_url: t.logo_url || t.personal_finance_category_icon_url || null,
  };
}

function accountFromPlaid(a, itemId) {
  return {
    account_id: a.account_id,
    item_id: itemId,
    name: a.name,
    official_name: a.official_name || null,
    mask: a.mask || null,
    type: a.type,
    subtype: a.subtype || null,
    current_balance: a.balances?.current ?? null,
    available_balance: a.balances?.available ?? null,
    iso_currency_code: a.balances?.iso_currency_code || null,
  };
}

// ------------------------------------------------- Postgres / CockroachDB --
// Works with Postgres and CockroachDB.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    institution_id TEXT,
    institution_name TEXT,
    cursor TEXT,
    error TEXT,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    name TEXT, official_name TEXT, mask TEXT, type TEXT, subtype TEXT,
    current_balance NUMERIC, available_balance NUMERIC, iso_currency_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    authorized_date DATE,
    name TEXT, merchant_name TEXT,
    amount NUMERIC NOT NULL,
    iso_currency_code TEXT,
    category TEXT, category_detailed TEXT,
    pending BOOLEAN NOT NULL DEFAULT false,
    payment_channel TEXT, logo_url TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions (date DESC)`,
  `CREATE INDEX IF NOT EXISTS transactions_account_idx ON transactions (account_id)`,
];

const SERIALIZATION_FAILURE = '40001'; // CockroachDB asks clients to retry these

// SSL follows the URL's sslmode (e.g. ?sslmode=verify-full for CockroachDB Cloud).
// PGSSL=true forces SSL without certificate verification for hosts that need it.
class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const opts = { connectionString: url, max: 5, connectionTimeoutMillis: 10000 };
    if (process.env.PGSSL === 'true') opts.ssl = { rejectUnauthorized: false };
    this.pool = new Pool(opts);
    this.pool.on('error', (err) => console.error('idle database client error', err.message));
  }

  async init() {
    // One statement per query: CockroachDB doesn't like several schema changes in one implicit transaction.
    for (const sql of SCHEMA) await this.pool.query(sql);
  }

  async listItems() {
    const { rows } = await this.pool.query('SELECT * FROM items ORDER BY created_at');
    return rows;
  }

  async getItem(itemId) {
    const { rows } = await this.pool.query('SELECT * FROM items WHERE item_id = $1', [itemId]);
    return rows[0] || null;
  }

  async saveItem({ item_id, access_token, institution_id, institution_name }) {
    await this.pool.query(
      `INSERT INTO items (item_id, access_token, institution_id, institution_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id) DO UPDATE SET access_token = EXCLUDED.access_token`,
      [item_id, access_token, institution_id, institution_name],
    );
  }

  async setItemError(itemId, error) {
    await this.pool.query('UPDATE items SET error = $2 WHERE item_id = $1', [itemId, error]);
  }

  async deleteItem(itemId) {
    await this.pool.query('DELETE FROM items WHERE item_id = $1', [itemId]);
  }

  async applySync(itemId, batch) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.applySyncOnce(itemId, batch);
      } catch (err) {
        if (err.code !== SERIALIZATION_FAILURE || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  }

  async applySyncOnce(itemId, { accounts, added, modified, removed, cursor }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of accounts.map((x) => accountFromPlaid(x, itemId))) {
        await client.query(
          `INSERT INTO accounts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (account_id) DO UPDATE SET
             name=$3, official_name=$4, mask=$5, type=$6, subtype=$7,
             current_balance=$8, available_balance=$9, iso_currency_code=$10`,
          Object.values(a),
        );
      }
      for (const t of [...added, ...modified].map((x) => txFromPlaid(x, itemId))) {
        await client.query(
          `INSERT INTO transactions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (transaction_id) DO UPDATE SET
             account_id=$2, date=$4, authorized_date=$5, name=$6, merchant_name=$7,
             amount=$8, iso_currency_code=$9, category=$10, category_detailed=$11,
             pending=$12, payment_channel=$13, logo_url=$14`,
          Object.values(t),
        );
      }
      if (removed.length) {
        await client.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [
          removed.map((r) => r.transaction_id),
        ]);
      }
      await client.query(
        'UPDATE items SET cursor = $2, error = NULL, last_synced_at = now() WHERE item_id = $1',
        [itemId, cursor],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listAccounts() {
    const { rows } = await this.pool.query(
      `SELECT a.*, i.institution_name FROM accounts a JOIN items i USING (item_id)
       ORDER BY i.institution_name, a.name`,
    );
    return rows.map((r) => ({
      ...r,
      current_balance: r.current_balance === null ? null : Number(r.current_balance),
      available_balance: r.available_balance === null ? null : Number(r.available_balance),
    }));
  }

  async listCategories() {
    const { rows } = await this.pool.query(
      'SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL ORDER BY 1',
    );
    return rows.map((r) => r.category);
  }

  async listTransactions(f) {
    const where = [];
    const params = [];
    const p = (v) => (params.push(v), `$${params.length}`);
    if (f.accountId) where.push(`account_id = ${p(f.accountId)}`);
    if (f.start) where.push(`date >= ${p(f.start)}`);
    if (f.end) where.push(`date <= ${p(f.end)}`);
    if (f.category) where.push(`category = ${p(f.category)}`);
    if (f.q) {
      const like = p(`%${f.q}%`);
      where.push(`(name ILIKE ${like} OR merchant_name ILIKE ${like})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const summary = await this.pool.query(
      `SELECT count(*) AS total,
              COALESCE(sum(CASE WHEN amount > 0 THEN amount END), 0)::float AS outflow,
              COALESCE(sum(CASE WHEN amount < 0 THEN -amount END), 0)::float AS inflow
       FROM transactions ${clause}`,
      params,
    );
    const { rows } = await this.pool.query(
      `SELECT transaction_id, account_id, item_id,
              date::text AS date, authorized_date::text AS authorized_date,
              name, merchant_name, amount::float AS amount, iso_currency_code,
              category, category_detailed, pending, payment_channel, logo_url
       FROM transactions ${clause}
       ORDER BY date DESC, transaction_id
       LIMIT ${p(f.limit)} OFFSET ${p(f.offset)}`,
      params,
    );
    // count() is INT8, which node-pg returns as a string.
    const { total, outflow, inflow } = summary.rows[0];
    return { total: Number(total), outflow: Number(outflow), inflow: Number(inflow), transactions: rows };
  }
}

// --------------------------------------------------------------- JSON file --
class FileStore {
  constructor(file) {
    this.file = file;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { items: {}, accounts: {}, transactions: {} };
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  async listItems() {
    return Object.values(this.data.items);
  }

  async getItem(itemId) {
    return this.data.items[itemId] || null;
  }

  async saveItem(item) {
    const existing = this.data.items[item.item_id];
    this.data.items[item.item_id] = existing
      ? { ...existing, access_token: item.access_token }
      : { cursor: null, error: null, last_synced_at: null, created_at: new Date().toISOString(), ...item };
    this.save();
  }

  async setItemError(itemId, error) {
    if (this.data.items[itemId]) this.data.items[itemId].error = error;
    this.save();
  }

  async deleteItem(itemId) {
    delete this.data.items[itemId];
    for (const [k, v] of Object.entries(this.data.accounts)) if (v.item_id === itemId) delete this.data.accounts[k];
    for (const [k, v] of Object.entries(this.data.transactions)) if (v.item_id === itemId) delete this.data.transactions[k];
    this.save();
  }

  async applySync(itemId, { accounts, added, modified, removed, cursor }) {
    for (const a of accounts) this.data.accounts[a.account_id] = accountFromPlaid(a, itemId);
    for (const t of [...added, ...modified]) this.data.transactions[t.transaction_id] = txFromPlaid(t, itemId);
    for (const r of removed) delete this.data.transactions[r.transaction_id];
    Object.assign(this.data.items[itemId], { cursor, error: null, last_synced_at: new Date().toISOString() });
    this.save();
  }

  async listAccounts() {
    return Object.values(this.data.accounts)
      .map((a) => ({ ...a, institution_name: this.data.items[a.item_id]?.institution_name }))
      .sort((a, b) => `${a.institution_name}${a.name}`.localeCompare(`${b.institution_name}${b.name}`));
  }

  async listCategories() {
    return [...new Set(Object.values(this.data.transactions).map((t) => t.category).filter(Boolean))].sort();
  }

  async listTransactions(f) {
    const q = f.q?.toLowerCase();
    const all = Object.values(this.data.transactions)
      .filter(
        (t) =>
          (!f.accountId || t.account_id === f.accountId) &&
          (!f.start || t.date >= f.start) &&
          (!f.end || t.date <= f.end) &&
          (!f.category || t.category === f.category) &&
          (!q || t.name?.toLowerCase().includes(q) || t.merchant_name?.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || a.transaction_id.localeCompare(b.transaction_id));
    return {
      total: all.length,
      outflow: all.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0),
      inflow: all.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0),
      transactions: all.slice(f.offset, f.offset + f.limit),
    };
  }
}

function createStore() {
  return process.env.DATABASE_URL
    ? new PgStore(process.env.DATABASE_URL)
    : new FileStore(path.join(__dirname, 'data', 'store.json'));
}

module.exports = { createStore };
