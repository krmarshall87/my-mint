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
    credit_limit: a.balances?.limit ?? null,
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
  `CREATE TABLE IF NOT EXISTS budgets (
    category TEXT PRIMARY KEY,
    amount NUMERIC NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Your corrections: rules match merchant text; overrides pin one transaction.
  `CREATE TABLE IF NOT EXISTS category_rules (
    pattern TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Mint-style rules, applied top to bottom (lowest position first).
  `CREATE TABLE IF NOT EXISTS tx_rules (
    id TEXT PRIMARY KEY,
    position INT NOT NULL,
    match_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    account_id TEXT,
    amount_min NUMERIC,
    amount_max NUMERIC,
    rename_to TEXT,
    category TEXT,
    start_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS category_overrides (
    transaction_id TEXT PRIMARY KEY,
    category TEXT NOT NULL
  )`,
  // Accounts you add yourself and fill from CSV files (cards Plaid can't reach).
  `CREATE TABLE IF NOT EXISTS manual_accounts (
    account_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    login_url TEXT,
    column_map TEXT,
    last_imported_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // One balance per account per day, for net worth over time (Plaid only
  // reports today's balance, so history has to be recorded as it happens).
  `CREATE TABLE IF NOT EXISTS balance_snapshots (
    date DATE NOT NULL,
    account_id TEXT NOT NULL,
    balance NUMERIC NOT NULL,
    PRIMARY KEY (date, account_id)
  )`,
  // What each investment account holds, replaced on every sync.
  `CREATE TABLE IF NOT EXISTS holdings (
    account_id TEXT NOT NULL,
    security_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    ticker TEXT,
    name TEXT,
    type TEXT,
    quantity NUMERIC,
    price NUMERIC,
    value NUMERIC,
    cost_basis NUMERIC,
    iso_currency_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, security_id)
  )`,
  // Credit card statements from Plaid Liabilities (JSON), replaced on every sync.
  `CREATE TABLE IF NOT EXISTS card_statements (
    account_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Your own card details (APR, promo, statement for manual cards); never touched by a sync.
  `CREATE TABLE IF NOT EXISTS card_settings (
    account_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS account_nicknames (
    account_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL
  )`,
  // Added later; one ALTER per statement (CockroachDB).
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_limit NUMERIC`,
  `ALTER TABLE items ADD COLUMN IF NOT EXISTS consent_expires_at TIMESTAMPTZ`,
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
       ON CONFLICT (item_id) DO UPDATE SET access_token = EXCLUDED.access_token,
         institution_name = COALESCE(EXCLUDED.institution_name, items.institution_name)`,
      [item_id, access_token, institution_id, institution_name],
    );
  }

  async setItemError(itemId, error) {
    await this.pool.query('UPDATE items SET error = $2 WHERE item_id = $1', [itemId, error]);
  }

  async setItemConsentExpiry(itemId, at) {
    await this.pool.query('UPDATE items SET consent_expires_at = $2 WHERE item_id = $1', [itemId, at]);
  }

  async deleteItem(itemId) {
    await this.pool.query('DELETE FROM category_overrides WHERE transaction_id IN (SELECT transaction_id FROM transactions WHERE item_id = $1)', [itemId]);
    await this.pool.query('DELETE FROM account_nicknames WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = $1)', [itemId]);
    await this.pool.query('DELETE FROM manual_accounts WHERE item_id = $1', [itemId]);
    await this.pool.query('DELETE FROM holdings WHERE item_id = $1', [itemId]);
    await this.pool.query('DELETE FROM card_statements WHERE item_id = $1', [itemId]);
    await this.pool.query('DELETE FROM card_settings WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = $1)', [itemId]);
    await this.pool.query('DELETE FROM balance_snapshots WHERE account_id IN (SELECT account_id FROM accounts WHERE item_id = $1)', [itemId]);
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
          `INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype, current_balance, available_balance, iso_currency_code, credit_limit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (account_id) DO UPDATE SET
             name=$3, official_name=$4, mask=$5, type=$6, subtype=$7,
             current_balance=$8, available_balance=$9, iso_currency_code=$10, credit_limit=$11`,
          [a.account_id, a.item_id, a.name, a.official_name, a.mask, a.type, a.subtype, a.current_balance, a.available_balance, a.iso_currency_code, a.credit_limit],
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
      `SELECT a.*, i.institution_name, n.nickname FROM accounts a JOIN items i USING (item_id)
       LEFT JOIN account_nicknames n USING (account_id)
       ORDER BY i.institution_name, a.name`,
    );
    return rows.map((r) => ({
      ...r,
      current_balance: r.current_balance === null ? null : Number(r.current_balance),
      available_balance: r.available_balance === null ? null : Number(r.available_balance),
      credit_limit: r.credit_limit == null ? null : Number(r.credit_limit),
    }));
  }

  async listTxRules() {
    const { rows } = await this.pool.query(
      `SELECT id, position, match_type, pattern, account_id, amount_min, amount_max, rename_to, category,
              start_date::text AS start_date
       FROM tx_rules ORDER BY position, created_at`,
    );
    const num = (v) => (v === null ? null : Number(v));
    return rows.map((r) => ({ ...r, position: Number(r.position), amount_min: num(r.amount_min), amount_max: num(r.amount_max) }));
  }

  async saveTxRule(r) {
    await this.pool.query(
      `INSERT INTO tx_rules (id, position, match_type, pattern, account_id, amount_min, amount_max, rename_to, category, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, match_type = EXCLUDED.match_type,
         pattern = EXCLUDED.pattern, account_id = EXCLUDED.account_id, amount_min = EXCLUDED.amount_min,
         amount_max = EXCLUDED.amount_max, rename_to = EXCLUDED.rename_to, category = EXCLUDED.category,
         start_date = EXCLUDED.start_date`,
      [r.id, r.position, r.match_type, r.pattern, r.account_id, r.amount_min, r.amount_max, r.rename_to, r.category, r.start_date],
    );
  }

  async deleteTxRule(id) {
    await this.pool.query('DELETE FROM tx_rules WHERE id = $1', [id]);
  }

  async listManualAccounts() {
    const { rows } = await this.pool.query('SELECT account_id, item_id, login_url, column_map, last_imported_at FROM manual_accounts');
    return rows.map((r) => ({ ...r, column_map: r.column_map ? JSON.parse(r.column_map) : null, last_imported_at: r.last_imported_at ? new Date(r.last_imported_at).toISOString() : null }));
  }

  async saveManualAccount(m) {
    await this.pool.query(
      `INSERT INTO manual_accounts (account_id, item_id, login_url, column_map, last_imported_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id) DO UPDATE SET login_url = EXCLUDED.login_url, column_map = EXCLUDED.column_map,
         last_imported_at = EXCLUDED.last_imported_at`,
      [m.account_id, m.item_id, m.login_url, m.column_map ? JSON.stringify(m.column_map) : null, m.last_imported_at],
    );
  }

  async saveSnapshots(date, rows) {
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO balance_snapshots (date, account_id, balance) VALUES ($1, $2, $3)
         ON CONFLICT (date, account_id) DO UPDATE SET balance = EXCLUDED.balance`,
        [date, r.account_id, r.balance],
      );
    }
  }

  async listSnapshots() {
    const { rows } = await this.pool.query('SELECT date::text AS date, account_id, balance FROM balance_snapshots ORDER BY date');
    return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
  }

  async replaceHoldings(itemId, rows) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM holdings WHERE item_id = $1', [itemId]);
      for (const h of rows) {
        await client.query(
          `INSERT INTO holdings (account_id, security_id, item_id, ticker, name, type, quantity, price, value, cost_basis, iso_currency_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (account_id, security_id) DO UPDATE SET quantity = EXCLUDED.quantity, price = EXCLUDED.price,
             value = EXCLUDED.value, cost_basis = EXCLUDED.cost_basis, updated_at = now()`,
          [h.account_id, h.security_id, itemId, h.ticker, h.name, h.type, h.quantity, h.price, h.value, h.cost_basis, h.iso_currency_code],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async replaceCardStatements(itemId, rows) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM card_statements WHERE item_id = $1', [itemId]);
      for (const r of rows) {
        await client.query(
          `INSERT INTO card_statements (account_id, item_id, data) VALUES ($1, $2, $3)
           ON CONFLICT (account_id) DO UPDATE SET item_id = EXCLUDED.item_id, data = EXCLUDED.data, updated_at = now()`,
          [r.account_id, itemId, JSON.stringify(r)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listCardStatements() {
    const { rows } = await this.pool.query('SELECT item_id, data, updated_at FROM card_statements');
    return rows.map((r) => ({ ...JSON.parse(r.data), item_id: r.item_id, updated_at: new Date(r.updated_at).toISOString() }));
  }

  async listCardSettings() {
    const { rows } = await this.pool.query('SELECT account_id, data FROM card_settings');
    return rows.map((r) => ({ ...JSON.parse(r.data), account_id: r.account_id }));
  }

  async setCardSettings(accountId, data) {
    if (data === null) {
      await this.pool.query('DELETE FROM card_settings WHERE account_id = $1', [accountId]);
    } else {
      await this.pool.query(
        `INSERT INTO card_settings (account_id, data) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [accountId, JSON.stringify(data)],
      );
    }
  }

  async listHoldings() {
    const { rows } = await this.pool.query('SELECT * FROM holdings ORDER BY value DESC');
    const num = (v) => (v === null ? null : Number(v));
    return rows.map((r) => ({ ...r, quantity: num(r.quantity), price: num(r.price), value: num(r.value), cost_basis: num(r.cost_basis), updated_at: new Date(r.updated_at).toISOString() }));
  }

  async listRules() {
    const { rows } = await this.pool.query('SELECT pattern, category FROM category_rules ORDER BY pattern');
    return rows;
  }

  async deleteRule(pattern) {
    await this.pool.query('DELETE FROM category_rules WHERE pattern = $1', [pattern]);
  }

  async listOverrides() {
    const { rows } = await this.pool.query('SELECT transaction_id, category FROM category_overrides');
    return rows;
  }

  async setOverride(transactionId, category) {
    if (category === null) {
      await this.pool.query('DELETE FROM category_overrides WHERE transaction_id = $1', [transactionId]);
    } else {
      await this.pool.query(
        `INSERT INTO category_overrides (transaction_id, category) VALUES ($1, $2)
         ON CONFLICT (transaction_id) DO UPDATE SET category = EXCLUDED.category`,
        [transactionId, category],
      );
    }
  }

  async setNickname(accountId, nickname) {
    if (nickname === null) {
      await this.pool.query('DELETE FROM account_nicknames WHERE account_id = $1', [accountId]);
    } else {
      await this.pool.query(
        `INSERT INTO account_nicknames (account_id, nickname) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET nickname = EXCLUDED.nickname`,
        [accountId, nickname],
      );
    }
  }

  async listBudgets() {
    const { rows } = await this.pool.query('SELECT category, amount FROM budgets ORDER BY category');
    return rows.map((r) => ({ category: r.category, amount: Number(r.amount) }));
  }

  async setBudget(category, amount) {
    await this.pool.query(
      `INSERT INTO budgets (category, amount) VALUES ($1, $2)
       ON CONFLICT (category) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
      [category, amount],
    );
  }

  async deleteBudget(category) {
    await this.pool.query('DELETE FROM budgets WHERE category = $1', [category]);
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
      : { items: {}, accounts: {}, transactions: {}, budgets: {} };
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
      ? { ...existing, access_token: item.access_token, institution_name: item.institution_name ?? existing.institution_name }
      : { cursor: null, error: null, last_synced_at: null, created_at: new Date().toISOString(), ...item };
    this.save();
  }

  async setItemError(itemId, error) {
    if (this.data.items[itemId]) this.data.items[itemId].error = error;
    this.save();
  }

  async setItemConsentExpiry(itemId, at) {
    if (this.data.items[itemId]) this.data.items[itemId].consent_expires_at = at;
    this.save();
  }

  async deleteItem(itemId) {
    delete this.data.items[itemId];
    for (const [k, v] of Object.entries(this.data.accounts)) if (v.item_id === itemId) {
      delete this.data.accounts[k]; delete this.data.nicknames?.[k]; delete this.data.manual?.[k];
      this.data.snapshots = (this.data.snapshots || []).filter((x) => x.account_id !== k);
      this.data.holdings = (this.data.holdings || []).filter((x) => x.account_id !== k);
      delete this.data.cardStatements?.[k]; delete this.data.cardSettings?.[k];
    }
    for (const [k, v] of Object.entries(this.data.transactions)) if (v.item_id === itemId) { delete this.data.transactions[k]; delete this.data.overrides?.[k]; }
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
      .map((a) => ({ ...a, institution_name: this.data.items[a.item_id]?.institution_name, nickname: this.data.nicknames?.[a.account_id] ?? null }))
      .sort((a, b) => `${a.institution_name}${a.name}`.localeCompare(`${b.institution_name}${b.name}`));
  }

  async listTxRules() {
    return [...(this.data.txRules || [])].sort((a, b) => a.position - b.position);
  }

  async saveTxRule(r) {
    const list = (this.data.txRules ||= []);
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = { ...r }; else list.push({ ...r });
    this.save();
  }

  async deleteTxRule(id) {
    this.data.txRules = (this.data.txRules || []).filter((r) => r.id !== id);
    this.save();
  }

  async listManualAccounts() {
    return Object.values(this.data.manual || {}).map((m) => ({ ...m }));
  }

  async saveManualAccount(m) {
    (this.data.manual ||= {})[m.account_id] = { ...m };
    this.save();
  }

  async saveSnapshots(date, rows) {
    const list = (this.data.snapshots ||= []);
    for (const r of rows) {
      const i = list.findIndex((x) => x.date === date && x.account_id === r.account_id);
      if (i >= 0) list[i].balance = r.balance; else list.push({ date, account_id: r.account_id, balance: r.balance });
    }
    this.save();
  }

  async listSnapshots() {
    return [...(this.data.snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
  }

  async replaceHoldings(itemId, rows) {
    const now = new Date().toISOString();
    this.data.holdings = (this.data.holdings || []).filter((h) => h.item_id !== itemId).concat(rows.map((h) => ({ ...h, item_id: itemId, updated_at: now })));
    this.save();
  }

  async replaceCardStatements(itemId, rows) {
    const now = new Date().toISOString();
    this.data.cardStatements ||= {};
    for (const [k, v] of Object.entries(this.data.cardStatements)) if (v.item_id === itemId) delete this.data.cardStatements[k];
    for (const r of rows) this.data.cardStatements[r.account_id] = { ...r, item_id: itemId, updated_at: now };
    this.save();
  }

  async listCardStatements() {
    return Object.values(this.data.cardStatements || {});
  }

  async listCardSettings() {
    return Object.entries(this.data.cardSettings || {}).map(([account_id, d]) => ({ ...d, account_id }));
  }

  async setCardSettings(accountId, data) {
    this.data.cardSettings ||= {};
    if (data === null) delete this.data.cardSettings[accountId];
    else this.data.cardSettings[accountId] = data;
    this.save();
  }

  async listHoldings() {
    return [...(this.data.holdings || [])].sort((a, b) => (b.value || 0) - (a.value || 0));
  }

  async listRules() {
    return Object.entries(this.data.rules || {})
      .map(([pattern, category]) => ({ pattern, category }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  async deleteRule(pattern) {
    if (this.data.rules) delete this.data.rules[pattern];
    this.save();
  }

  async listOverrides() {
    return Object.entries(this.data.overrides || {}).map(([transaction_id, category]) => ({ transaction_id, category }));
  }

  async setOverride(transactionId, category) {
    this.data.overrides ||= {};
    if (category === null) delete this.data.overrides[transactionId];
    else this.data.overrides[transactionId] = category;
    this.save();
  }

  async setNickname(accountId, nickname) {
    this.data.nicknames ||= {};
    if (nickname === null) delete this.data.nicknames[accountId];
    else this.data.nicknames[accountId] = nickname;
    this.save();
  }

  async listBudgets() {
    return Object.entries(this.data.budgets || {})
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  async setBudget(category, amount) {
    (this.data.budgets ||= {})[category] = amount;
    this.save();
  }

  async deleteBudget(category) {
    if (this.data.budgets) delete this.data.budgets[category];
    this.save();
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
    : new FileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json'));
}

module.exports = { createStore };
