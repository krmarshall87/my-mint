const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { createStore } = require('./db');
const { TREE, isKnownCategory, parentOf, isExcluded, isIncome, fromPlaid, fromLegacy, UNCATEGORIZED } = require('./categories');

const {
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV = 'sandbox',
  PLAID_REDIRECT_URI,
  APP_PASSWORD,
  PORT = 3000,
} = process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('PLAID_CLIENT_ID and PLAID_SECRET must be set.');
  process.exit(1);
}
if (!APP_PASSWORD && process.env.NODE_ENV === 'production') {
  console.error('APP_PASSWORD must be set in production; refusing to expose financial data without auth.');
  process.exit(1);
}
if (!PlaidEnvironments[PLAID_ENV]) {
  console.error(`Unknown PLAID_ENV "${PLAID_ENV}". Use one of: ${Object.keys(PlaidEnvironments).join(', ')}`);
  process.exit(1);
}

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID, 'PLAID-SECRET': PLAID_SECRET } },
  }),
);
const store = createStore();

// ------------------------------------------------- token encryption --
// Plaid access tokens are encrypted at rest (AES-256-GCM) when ENCRYPTION_KEY is set.
const ENC_KEY = process.env.ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest()
  : null;
if (!ENC_KEY && process.env.NODE_ENV === 'production') {
  console.warn('ENCRYPTION_KEY is not set; Plaid access tokens will be stored unencrypted.');
}
function encryptToken(plain) {
  if (!ENC_KEY) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}
function decryptToken(stored) {
  if (!stored.startsWith('enc:v1:')) return stored;
  if (!ENC_KEY) throw new Error('Stored access token is encrypted but ENCRYPTION_KEY is not set');
  const buf = Buffer.from(stored.slice(7), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
const withPlainToken = (item) => item && { ...item, access_token: decryptToken(item.access_token) };
const items = {
  list: async () => (await store.listItems()).map(withPlainToken),
  get: async (id) => withPlainToken(await store.getItem(id)),
  save: (item) => store.saveItem({ ...item, access_token: encryptToken(item.access_token) }),
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// ------------------------------------------------------------------- auth --
// HTTP Basic Auth (any username, password = APP_PASSWORD). Render serves over HTTPS.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Security headers. Plaid Link loads its script and iframe from cdn.plaid.com.
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://cdn.plaid.com",
      "frame-src https://cdn.plaid.com",
      "connect-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'", // Plaid's link-initialize.js sets inline styles
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

app.get('/healthz', (_req, res) => res.send('ok'));

// Icons are served without auth: browsers and iOS home screens fetch them
// without credentials, and they contain no data.
const PUBLIC_ICONS = ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png'];
app.get(PUBLIC_ICONS, (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(__dirname, 'public', req.path));
});

// Lock out an IP after too many wrong passwords.
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first }
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const now = Date.now();
  const rec = failures.get(req.ip);
  if (rec && now - rec.first > LOCKOUT_MS) failures.delete(req.ip);
  if ((failures.get(req.ip)?.count || 0) >= MAX_FAILURES) {
    return res.status(429).send('Too many failed login attempts. Try again later.');
  }
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(password, APP_PASSWORD)) return next();
    const r = failures.get(req.ip) || { count: 0, first: now };
    r.count += 1;
    failures.set(req.ip, r);
  }
  res.set('WWW-Authenticate', 'Basic realm="my-mint", charset="UTF-8"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'public')));

// The server listens before the database is ready (so Render's port check passes);
// API calls get a 503 until the schema is in place.
let dbReady = false;
app.use('/api', (_req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error_message: 'Database is starting up. Try again in a moment.' });
});

// ------------------------------------------------------------------ plaid --
function plaidError(err) {
  return err.response?.data || { error_message: err.message };
}

// Pull all new/changed/removed transactions for an item since its last cursor.
async function syncItem(item) {
  const startCursor = item.cursor || undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = startCursor;
    const added = [], modified = [], removed = [];
    let accounts = [];
    try {
      let hasMore = true;
      while (hasMore) {
        const { data } = await plaid.transactionsSync({
          access_token: item.access_token,
          cursor,
          count: 500,
          options: { include_personal_finance_category: true },
        });
        added.push(...data.added);
        modified.push(...data.modified);
        removed.push(...data.removed);
        accounts = data.accounts;
        hasMore = data.has_more;
        cursor = data.next_cursor;
      }
      // Plaid returns an empty cursor while the initial pull is still being prepared.
      if (!cursor && !added.length) return { added: 0, modified: 0, removed: 0, pending_initial_pull: true };
      await store.applySync(item.item_id, { accounts, added, modified, removed, cursor });
      bumpData();
      return { added: added.length, modified: modified.length, removed: removed.length };
    } catch (err) {
      const code = err.response?.data?.error_code;
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue; // restart from startCursor
      await store.setItemError(item.item_id, code || err.message);
      throw err;
    }
  }
  throw new Error('Transactions kept changing during sync; try again.');
}

// Sync every linked Item. Concurrent callers share one run so cursors never race.
let syncInFlight = null;
function syncAll() {
  syncInFlight ||= (async () => {
    const results = [];
    for (const item of await items.list()) {
      if (isManualItem(item)) continue; // filled from CSV files, not Plaid
      try {
        results.push({ item_id: item.item_id, ...(await syncItem(item)) });
      } catch (err) {
        results.push({ item_id: item.item_id, error: plaidError(err) });
      }
    }
    await recordSnapshots().catch((err) => console.error('snapshot failed', err.message));
    return results;
  })().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

app.post('/api/link-token', async (req, res) => {
  try {
    const request = {
      user: { client_user_id: 'owner' },
      client_name: 'My Mint',
      country_codes: [CountryCode.Us],
      language: 'en',
    };
    if (PLAID_REDIRECT_URI) request.redirect_uri = PLAID_REDIRECT_URI;
    const itemId = req.body?.item_id;
    if (itemId) {
      // Update mode: re-authenticate an existing connection.
      const item = await items.get(itemId);
      if (!item) return res.status(404).json({ error_message: 'Unknown item' });
      request.access_token = item.access_token;
    } else {
      request.products = [Products.Transactions];
      request.transactions = { days_requested: 730 };
    }
    const { data } = await plaid.linkTokenCreate(request);
    res.json({ link_token: data.link_token });
  } catch (err) {
    console.error('link-token', plaidError(err));
    res.status(500).json(plaidError(err));
  }
});

app.post('/api/exchange', async (req, res) => {
  try {
    const { public_token, institution } = req.body;
    const { data } = await plaid.itemPublicTokenExchange({ public_token });
    const item = {
      item_id: data.item_id,
      access_token: data.access_token,
      institution_id: institution?.institution_id || null,
      institution_name: institution?.name || 'Bank',
    };
    await items.save(item);
    let sync = null;
    try {
      sync = await syncItem(await items.get(item.item_id));
    } catch (err) {
      console.error('initial sync', plaidError(err));
    }
    res.json({ item_id: item.item_id, sync });
  } catch (err) {
    console.error('exchange', plaidError(err));
    res.status(500).json(plaidError(err));
  }
});

app.post('/api/sync', async (_req, res) => {
  res.json({ results: await syncAll() });
});

app.get('/api/items', async (_req, res) => {
  res.json((await store.listItems()).map(({ access_token, cursor, ...rest }) => ({ ...rest, manual: isManualItem(rest) })));
});

app.delete('/api/items/:id', async (req, res) => {
  const item = await items.get(req.params.id);
  if (!item) return res.status(404).json({ error_message: 'Unknown item' });
  if (!isManualItem(item)) {
    try {
      await plaid.itemRemove({ access_token: item.access_token });
    } catch (err) {
      console.error('item remove', plaidError(err));
    }
  }
  await store.deleteItem(item.item_id);
  bumpData();
  res.json({ ok: true });
});

// -------------------------------------------------------------- accounts --
// Banks often name accounts generically ("CREDIT CARD", "Checking - 6709").
// Prefer your nickname, then the bank's official product name, then
// "<Bank> <Name>", tidied up.
const GENERIC_NAME = /^(credit card|credit|card|checking|savings?|spending|account|money market|cd|loan|visa|mastercard)$/i;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
function displayName(a) {
  if (a.nickname) return a.nickname;
  let name = (a.name || '').trim();
  if (a.mask) name = name.replace(new RegExp(`[\\s\\-–#x*]*${a.mask.replace(/\W/g, '')}$`, 'i'), '').trim() || name;
  const shouting = /[A-Z]/.test(name) && name === name.toUpperCase();
  const official = (a.official_name || '').trim();
  if (official && (GENERIC_NAME.test(name) || shouting)) return official;
  if (GENERIC_NAME.test(name)) return `${a.institution_name ? `${a.institution_name} ` : ''}${titleCase(name)}`;
  return shouting ? titleCase(name) : name;
}
// Manual accounts: added by you and filled from CSV files, for cards and
// accounts Plaid can't connect. Each has its own item (institution_id 'manual')
// so removing it works like removing a bank.
const MANUAL = 'manual';
const isManualItem = (item) => item?.institution_id === MANUAL;
const STALE_DAYS = () => Number(process.env.MANUAL_STALE_DAYS || 30);
const daysSince = (ts) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null);

async function listAccounts() {
  const [accounts, manual] = await Promise.all([store.listAccounts(), store.listManualAccounts()]);
  const meta = new Map(manual.map((m) => [m.account_id, m]));
  return accounts.map((a) => {
    const m = meta.get(a.account_id);
    const extra = m
      ? {
          manual: true,
          login_url: m.login_url,
          column_map: m.column_map,
          last_imported_at: m.last_imported_at,
          days_since_import: daysSince(m.last_imported_at),
          stale: m.last_imported_at === null || daysSince(m.last_imported_at) > STALE_DAYS(),
        }
      : { manual: false };
    return { ...a, ...extra, display_name: displayName(a) };
  });
}

app.get('/api/accounts', async (_req, res) => {
  res.json(await listAccounts());
});

app.patch('/api/accounts/:id', async (req, res) => {
  const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim().slice(0, 60) : null;
  const accounts = await store.listAccounts();
  if (!accounts.some((a) => a.account_id === req.params.id)) return res.status(404).json({ error_message: 'Unknown account' });
  await store.setNickname(req.params.id, nickname || null);
  res.json({ ok: true });
});

// ------------------------------------------------------- manual accounts --
const MANUAL_TYPES = ['credit', 'depository', 'loan', 'investment', 'other'];
function cleanLoginUrl(v) {
  if (v === undefined || v === null || v === '') return [null, null];
  try {
    const u = new URL(String(v).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return [null, 'The login page must start with https://'];
    return [u.toString().slice(0, 500), null];
  } catch { return [null, 'The login page isn’t a valid web address'] }
}
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function manualAccount(accountId) {
  const a = (await listAccounts()).find((x) => x.account_id === accountId);
  return a?.manual ? a : null;
}

// Write the account row (name, type, balance) through the normal sync path.
async function writeManualAccount(itemId, a, txns = []) {
  await store.applySync(itemId, {
    accounts: [{ account_id: a.account_id, name: a.name, official_name: null, mask: a.mask || null, type: a.type, subtype: null, balances: { current: a.current_balance ?? null, iso_currency_code: 'USD' } }],
    added: txns, modified: [], removed: [], cursor: null,
  });
}

app.post('/api/manual-accounts', async (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 60);
  if (!name) return res.status(400).json({ error_message: 'Give the account a name, e.g. Verizon Visa' });
  const type = MANUAL_TYPES.includes(b.type) ? b.type : 'credit';
  const [login_url, urlError] = cleanLoginUrl(b.login_url);
  if (urlError) return res.status(400).json({ error_message: urlError });
  const balance = b.balance === '' || b.balance == null ? null : Number(b.balance);
  if (balance !== null && !Number.isFinite(balance)) return res.status(400).json({ error_message: 'The balance must be a number' });
  const item_id = `manual-${crypto.randomUUID()}`;
  const account = { account_id: `manual-${crypto.randomUUID()}`, name, mask: cleanText(b.mask, 4) || null, type, current_balance: balance };
  await items.save({ item_id, access_token: MANUAL, institution_id: MANUAL, institution_name: cleanText(b.institution, 60) || name });
  await writeManualAccount(item_id, account);
  await store.saveManualAccount({ account_id: account.account_id, item_id, login_url, column_map: null, last_imported_at: null });
  bumpData();
  res.json(await manualAccount(account.account_id));
});

app.patch('/api/manual-accounts/:id', async (req, res) => {
  const a = await manualAccount(req.params.id);
  if (!a) return res.status(404).json({ error_message: 'Unknown manual account' });
  const b = req.body || {};
  const name = b.name === undefined ? a.name : cleanText(b.name, 60);
  if (!name) return res.status(400).json({ error_message: 'The account needs a name' });
  const [login_url, urlError] = b.login_url === undefined ? [a.login_url, null] : cleanLoginUrl(b.login_url);
  if (urlError) return res.status(400).json({ error_message: urlError });
  const type = MANUAL_TYPES.includes(b.type) ? b.type : a.type;
  const mask = b.mask === undefined ? a.mask : cleanText(b.mask, 4) || null;
  await writeManualAccount(a.item_id, { ...a, name, type, mask });
  if (b.institution !== undefined) {
    const item = await items.get(a.item_id);
    await items.save({ ...item, institution_name: cleanText(b.institution, 60) || name });
  }
  await store.saveManualAccount({ account_id: a.account_id, item_id: a.item_id, login_url, column_map: a.column_map, last_imported_at: a.last_imported_at });
  bumpData();
  res.json(await manualAccount(a.account_id));
});

// Import rows parsed from a CSV in the browser: [{ date, description, amount }],
// amount in Plaid's sign (positive = money out). Ids are derived from the row,
// so importing the same or an overlapping file never duplicates anything.
const MAX_IMPORT_ROWS = 20000;
app.post('/api/manual-accounts/:id/import', async (req, res) => {
  const a = await manualAccount(req.params.id);
  if (!a) return res.status(404).json({ error_message: 'Unknown manual account' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error_message: 'No transactions to import' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error_message: `At most ${MAX_IMPORT_ROWS} rows per import` });
  const seen = new Map();
  const txns = [];
  for (const [i, r] of rows.entries()) {
    const description = cleanText(r?.description, 200);
    const amount = Number(r?.amount);
    if (!isDate(r?.date) || !description || !Number.isFinite(amount)) return res.status(400).json({ error_message: `Row ${i + 1} is missing a date, description or amount` });
    const base = `${a.account_id}|${r.date}|${amount.toFixed(2)}|${normalizeText(description)}`;
    const n = (seen.get(base) || 0) + 1; // identical charges on the same day stay separate
    seen.set(base, n);
    const id = `m_${crypto.createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32)}`;
    txns.push({ transaction_id: id, account_id: a.account_id, date: r.date, name: description, merchant_name: null, amount: round2(amount), iso_currency_code: 'USD', pending: false, personal_finance_category: null });
  }
  const existing = new Set((await categorizedTransactions()).map((t) => t.transaction_id));
  const added = txns.filter((t) => !existing.has(t.transaction_id)).length;
  const balance = req.body.balance === '' || req.body.balance == null ? a.current_balance : Number(req.body.balance);
  await writeManualAccount(a.item_id, { ...a, current_balance: Number.isFinite(balance) ? balance : a.current_balance }, txns);
  const column_map = req.body.column_map && typeof req.body.column_map === 'object' ? req.body.column_map : a.column_map;
  await store.saveManualAccount({ account_id: a.account_id, item_id: a.item_id, login_url: a.login_url, column_map, last_imported_at: new Date().toISOString() });
  bumpData();
  const dates = txns.map((t) => t.date).sort();
  await recordSnapshots().catch(() => {});
  res.json({ added, already: txns.length - added, total: txns.length, start: dates[0], end: dates[dates.length - 1] });
});

// ------------------------------------------------------------ categories --
// Categories follow the Mint-style tree in categories.js. Plaid's category is
// the starting point (mapped onto the tree). On top of it, in priority order:
// your fix for one transaction, then the first of your rules that matches
// (top to bottom). Only when the result is still Uncategorized: what this
// merchant usually is in your own history, then a few built-in defaults.
const merchantText = (t) => `${t.merchant_name || ''} ${t.name || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
const merchantKey = (t) =>
  (t.merchant_name || t.name || '').toLowerCase().split('*')[0].replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const CARD_PAYMENT = /\b(payment|pymt|autopay|thank you)\b/i;
const DEFAULT_CATEGORIES = [
  [/\binstacart\b/, 'Groceries'],
  [/\b(doordash|grubhub|uber ?eats)\b/, 'Restaurants'],
  [/\bbest ?buy\b/, 'Electronics & Software'],
  [/\b(amazon|amzn|ebay|walmart|target|costco|etsy)\b/, 'Shopping'],
  [/\b(massage|spa|nails?)\b/, 'Spa & Massage'],
  [/\b(salon|barber)\b/, 'Hair'],
  [/\b(uber|lyft)\b/, 'Auto & Transport'],
  [/\bspotify\b/, 'Music'],
  [/\b(netflix|hulu|disney\+?|hbo)\b/, 'Movies & DVDs'],
];

// ---- rules ----
const MATCH_TYPES = ['contains', 'equals', 'starts'];
const normalizeText = (p) => (typeof p === 'string' ? p.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) : '');
function ruleMatches(r, t) {
  if (r.account_id && t.account_id !== r.account_id) return false;
  if (r.start_date && t.date < r.start_date) return false;
  const amt = Math.abs(t.amount);
  if (r.amount_min != null && amt < r.amount_min - 0.005) return false;
  if (r.amount_max != null && amt > r.amount_max + 0.005) return false;
  const names = [t.merchant_name, t.name].filter(Boolean).map(normalizeText);
  if (r.match_type === 'equals') return names.includes(r.pattern);
  if (r.match_type === 'starts') return names.some((n) => n.startsWith(r.pattern));
  return merchantText(t).includes(r.pattern);
}

// Everything below reads one categorized snapshot of all transactions, rebuilt
// only after something changes (a sync, a delete, or one of your edits).
let dataVersion = 0;
const bumpData = () => { dataVersion += 1; };
let snapshot = { version: -1, rows: [] };

async function categorizedTransactions() {
  if (snapshot.version === dataVersion) return snapshot.rows;
  const version = dataVersion;
  const [{ transactions }, rules, overrides] = await Promise.all([
    store.listTransactions({ accountId: null, start: null, end: null, category: null, q: null, limit: 1e6, offset: 0 }),
    store.listTxRules(),
    store.listOverrides(),
  ]);
  const accountType = new Map((await store.listAccounts()).map((a) => [a.account_id, a.type]));
  const override = new Map(overrides.map((o) => [o.transaction_id, o.category]));
  const plaidCat = (t) => fromPlaid(t.category, t.category_detailed);

  // What each merchant usually is, from transactions Plaid did categorize.
  const counts = new Map();
  for (const t of transactions) {
    const key = merchantKey(t);
    const c = plaidCat(t);
    if (!key || c === UNCATEGORIZED) continue;
    const m = counts.get(key) || new Map();
    m.set(c, (m.get(c) || 0) + 1);
    counts.set(key, m);
  }
  const usual = new Map([...counts].map(([key, m]) => [key, [...m].sort((a, b) => b[1] - a[1])[0][0]]));

  const rows = transactions.map((t) => {
    const text = merchantText(t);
    const rule = rules.find((r) => ruleMatches(r, t)); // first match wins
    let category = plaidCat(t);
    let source = 'plaid';
    if (override.has(t.transaction_id)) { category = override.get(t.transaction_id); source = 'manual'; }
    // A loan account's own activity isn't cash you spent: money arriving is
    // the other half of a payment you already count (the bill paid from
    // checking), and interest or escrow added to the balance is paid by that
    // same bill. Loans don't get refunds.
    else if (accountType.get(t.account_id) === 'loan') {
      category = t.amount < 0 ? 'Loan Payment Received' : 'Hide from Budgets & Trends';
      source = 'auto';
    }
    // A payment arriving on a card you import from CSV (no Plaid category):
    // the purchases already count, so the payment doesn't.
    else if (!t.category && accountType.get(t.account_id) === 'credit' && t.amount < 0 && CARD_PAYMENT.test(text)) { category = 'Credit Card Payment'; source = 'auto'; }
    else if (rule?.category) { category = rule.category; source = 'rule'; }
    else if (category === UNCATEGORIZED) {
      const guess = usual.get(merchantKey(t)) || DEFAULT_CATEGORIES.find(([re]) => re.test(text))?.[1];
      if (guess) { category = guess; source = 'inferred'; }
    }
    return {
      ...t,
      plaid_category: t.category,
      category,
      parent: parentOf(category),
      category_source: source,
      excluded: isExcluded(category),
      display_name: rule?.rename_to || null,
      rule_id: rule ? rule.id : null,
    };
  });
  if (version === dataVersion) snapshot = { version, rows };
  return rows;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function parseFilters(q) {
  return {
    accountId: q.account_id || null,
    start: isDate(q.start) ? q.start : null,
    end: isDate(q.end) ? q.end : null,
    category: q.category || null,
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim().toLowerCase() : null,
  };
}

// A parent category filter includes its subcategories.
const matchesFilters = (t, f) =>
  (!f.accountId || t.account_id === f.accountId) &&
  (!f.start || t.date >= f.start) &&
  (!f.end || t.date <= f.end) &&
  (!f.category || t.category === f.category || t.parent === f.category) &&
  (!f.q || merchantText(t).includes(f.q) || (t.display_name || '').toLowerCase().includes(f.q));

// Newest first, with your categories applied, filtered in JS: identical for both stores.
const allTransactions = async (filters = {}) => (await categorizedTransactions()).filter((t) => matchesFilters(t, filters));

app.get('/api/category-tree', (_req, res) => {
  res.json(TREE.map(([name, subs]) => ({ name, subs, excluded: isExcluded(name), income: isIncome(name) })));
});

app.get('/api/categories', async (_req, res) => {
  res.json([...new Set((await categorizedTransactions()).map((t) => t.category))].sort());
});

app.get('/api/transactions', async (req, res) => {
  const q = req.query;
  const rows = await allTransactions(parseFilters(q));
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 5000);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  res.json({ total: rows.length, transactions: rows.slice(offset, offset + limit) });
});

// New rules go to the top, so they take effect over older, broader ones.
async function topPosition() {
  const rules = await store.listTxRules();
  return rules.length ? Math.min(...rules.map((r) => r.position)) - 1 : 0;
}

// Recategorize one transaction, or (with `pattern`) create a "contains" rule
// for every matching transaction. `category: null` resets one transaction.
app.put('/api/transactions/:id/category', async (req, res) => {
  const { category = null } = req.body || {};
  const pattern = normalizeText(req.body?.pattern);
  if (category !== null && !isKnownCategory(category)) return res.status(400).json({ error_message: 'Invalid category' });
  const t = (await categorizedTransactions()).find((x) => x.transaction_id === req.params.id);
  if (!t) return res.status(404).json({ error_message: 'Unknown transaction' });
  if (pattern) {
    if (category === null) return res.status(400).json({ error_message: 'Choose a category for the rule' });
    if (pattern.length < 2) return res.status(400).json({ error_message: 'Make the matching text at least 2 characters' });
    const rule = { id: crypto.randomUUID(), position: await topPosition(), match_type: 'contains', pattern, account_id: null, amount_min: null, amount_max: null, rename_to: null, category, start_date: null };
    await store.saveTxRule(rule);
    // The rule covers this transaction too, unless it doesn't match.
    await store.setOverride(t.transaction_id, ruleMatches(rule, t) ? null : category);
  } else {
    await store.setOverride(t.transaction_id, category);
  }
  bumpData();
  res.json({ ok: true });
});

// Validate a rule from the editor. Returns [rule, error].
async function parseRule(body = {}) {
  const match_type = MATCH_TYPES.includes(body.match_type) ? body.match_type : 'contains';
  const pattern = normalizeText(body.pattern);
  if (pattern.length < 2) return [null, 'Enter at least 2 characters of the description to match'];
  const money = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const amount_min = money(body.amount_min), amount_max = money(body.amount_max);
  for (const v of [amount_min, amount_max]) if (v !== null && !(Number.isFinite(v) && v >= 0 && v < 1e9)) return [null, 'Amounts must be positive numbers'];
  if (amount_min !== null && amount_max !== null && amount_min > amount_max) return [null, 'The minimum amount is larger than the maximum'];
  const account_id = body.account_id || null;
  if (account_id && !(await store.listAccounts()).some((a) => a.account_id === account_id)) return [null, 'Unknown account'];
  const rename_to = typeof body.rename_to === 'string' && body.rename_to.trim() ? body.rename_to.trim().slice(0, 60) : null;
  const category = body.category || null;
  if (category && !isKnownCategory(category)) return [null, 'Invalid category'];
  if (!rename_to && !category) return [null, 'Choose a new name, a category, or both'];
  // "Only new transactions" starts the rule today; otherwise it covers your whole history.
  const start_date = body.apply_past === false ? (isDate(body.start_date) ? body.start_date : isoDate(new Date())) : null;
  return [{ match_type, pattern, account_id, amount_min: amount_min === null ? null : round2(amount_min), amount_max: amount_max === null ? null : round2(amount_max), rename_to, category, start_date }, null];
}

const ruleSample = (t) => ({ transaction_id: t.transaction_id, date: t.date, name: t.display_name || t.merchant_name || t.name, original: t.name, amount: t.amount, account_id: t.account_id, category: t.category });

app.get('/api/rules', async (_req, res) => {
  const [rules, rows] = await Promise.all([store.listTxRules(), categorizedTransactions()]);
  const applied = new Map();
  for (const t of rows) if (t.rule_id) applied.set(t.rule_id, (applied.get(t.rule_id) || 0) + 1);
  res.json(rules.map((r) => ({ ...r, matches: applied.get(r.id) || 0 })));
});

// What a rule would match, before you save it.
app.post('/api/rules/preview', async (req, res) => {
  const [rule, error] = await parseRule({ ...req.body, rename_to: req.body?.rename_to || 'x' });
  if (!rule) return res.status(400).json({ error_message: error });
  const rows = (await categorizedTransactions()).filter((t) => ruleMatches(rule, t));
  // Rules above this one win when both match.
  const shadowed = req.body?.id ? 0 : rows.filter((t) => t.rule_id).length;
  res.json({ count: rows.length, shadowed, sample: rows.slice(0, 6).map(ruleSample) });
});

app.post('/api/rules', async (req, res) => {
  const [rule, error] = await parseRule(req.body);
  if (!rule) return res.status(400).json({ error_message: error });
  const saved = { id: crypto.randomUUID(), position: await topPosition(), ...rule };
  await store.saveTxRule(saved);
  bumpData();
  res.json(saved);
});

app.put('/api/rules/:id', async (req, res) => {
  const existing = (await store.listTxRules()).find((r) => r.id === req.params.id);
  if (!existing) return res.status(404).json({ error_message: 'Unknown rule' });
  const [rule, error] = await parseRule({ ...req.body, start_date: req.body?.start_date ?? existing.start_date });
  if (!rule) return res.status(400).json({ error_message: error });
  const saved = { ...existing, ...rule };
  await store.saveTxRule(saved);
  bumpData();
  res.json(saved);
});

app.delete('/api/rules/:id', async (req, res) => {
  await store.deleteTxRule(req.params.id);
  bumpData();
  res.json({ ok: true });
});

// Reorder: `ids` lists every rule, top (applied first) to bottom.
app.post('/api/rules/order', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const rules = await store.listTxRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  if (ids.length !== rules.length || !ids.every((id) => byId.has(id))) return res.status(400).json({ error_message: 'Send every rule id exactly once' });
  for (const [i, id] of ids.entries()) if (byId.get(id).position !== i) await store.saveTxRule({ ...byId.get(id), position: i });
  bumpData();
  res.json({ ok: true });
});

// ---- export / import ----
// A rules file is portable JSON: { version: 1, rules: [...] } in priority order.
const RULE_FIELDS = ['match_type', 'pattern', 'account_id', 'amount_min', 'amount_max', 'rename_to', 'category', 'start_date'];
const ruleKey = (r) => [r.match_type, r.pattern, r.account_id || '', r.amount_min ?? '', r.amount_max ?? ''].join('|');
const MAX_IMPORT = 500;

app.get('/api/rules/export', async (_req, res) => {
  const rules = (await store.listTxRules()).map((r) => Object.fromEntries(RULE_FIELDS.map((f) => [f, r[f] ?? null])));
  res.set('Content-Disposition', `attachment; filename="my-mint-rules-${isoDate(new Date())}.json"`);
  res.json({ version: 1, exported_at: new Date().toISOString(), rules });
});

// Import rules below your existing ones, so rules you wrote yourself still win.
// With `dry_run`, nothing is saved: each rule comes back validated, flagged if
// you already have it, and with how many transactions it would actually change
// (ones no earlier rule already claims).
app.post('/api/rules/import', async (req, res) => {
  const incoming = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!incoming) return res.status(400).json({ error_message: 'Expected a rules file: { "rules": [ ... ] }' });
  if (incoming.length > MAX_IMPORT) return res.status(400).json({ error_message: `At most ${MAX_IMPORT} rules per import` });
  const [existing, rows] = await Promise.all([store.listTxRules(), categorizedTransactions()]);
  const have = new Set(existing.map(ruleKey));
  const claimed = new Set(rows.filter((t) => t.rule_id).map((t) => t.transaction_id));
  const results = [];
  for (const [index, raw] of incoming.entries()) {
    const [rule, error] = await parseRule({ ...raw, apply_past: raw?.start_date ? false : true });
    if (!rule) { results.push({ index, ok: false, error, pattern: raw?.pattern ?? null }); continue; }
    const key = ruleKey(rule);
    if (have.has(key)) { results.push({ index, ok: false, duplicate: true, error: 'You already have this rule', rule }); continue; }
    have.add(key);
    const hits = rows.filter((t) => !claimed.has(t.transaction_id) && ruleMatches(rule, t));
    for (const t of hits) claimed.add(t.transaction_id);
    results.push({ index, ok: true, rule, matches: hits.length, sample: hits.slice(0, 3).map(ruleSample) });
  }
  const valid = results.filter((r) => r.ok);
  if (req.body.dry_run) return res.json({ dry_run: true, results, will_add: valid.length });
  let position = existing.length ? Math.max(...existing.map((r) => r.position)) + 1 : 0;
  for (const r of valid) await store.saveTxRule({ id: crypto.randomUUID(), position: position++, ...r.rule });
  bumpData();
  res.json({ added: valid.length, skipped: results.filter((r) => !r.ok) });
});

// ------------------------------------------------------------- insights --
const round2 = (n) => Math.round(n * 100) / 100;
const merchantOf = (t) => t.display_name || t.merchant_name || t.name || 'Unknown';
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 86400000));

// Income is money in the Income categories (and dividends). Any other money in
// is a refund and reduces spending in its own category. Transfers, investment
// trades and hidden transactions count as neither.
function aggregate(transactions, { includeExcluded = false } = {}) {
  const out = { income: 0, spending: 0, categories: new Map(), subs: new Map(), months: new Map(), merchants: new Map(), counted: 0 };
  for (const t of transactions) {
    if (!includeExcluded && t.excluded) continue;
    out.counted += 1;
    const month = t.date.slice(0, 7);
    const m = out.months.get(month) || { month, income: 0, spending: 0 };
    if (isIncome(t.category)) {
      out.income -= t.amount;
      m.income -= t.amount;
    } else {
      out.spending += t.amount;
      m.spending += t.amount;
      out.categories.set(t.parent, (out.categories.get(t.parent) || 0) + t.amount);
      const subs = out.subs.get(t.parent) || new Map();
      subs.set(t.category, (subs.get(t.category) || 0) + t.amount);
      out.subs.set(t.parent, subs);
      if (t.amount > 0) {
        const name = merchantOf(t);
        const mer = out.merchants.get(name) || { name, amount: 0, count: 0 };
        mer.amount += t.amount;
        mer.count += 1;
        out.merchants.set(name, mer);
      }
    }
    out.months.set(month, m);
  }
  return out;
}

// Chart colors follow the category, not its rank in the current view: the seven
// biggest parent categories of all time own slots 1-7 and everything else is
// "Other", so changing a filter never repaints a category. Subcategories get
// slots by their all-time rank within their parent, for the drill-down.
const COLOR_SLOTS = 7;
const rankSlots = (entries) =>
  new Map([...entries].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, COLOR_SLOTS).map(([c], i) => [c, i + 1]));

// Aggregates for the charts, scoped by the same filters as the transaction list.
// Done in JS so it's identical for every store; a single user's history is small.
app.get('/api/insights', async (req, res) => {
  const filters = parseFilters(req.query);
  const [txns, allTime] = await Promise.all([allTransactions(filters), allTransactions()]);
  // An explicit category filter (e.g. Transfer) shows what was asked for instead of hiding it.
  const agg = aggregate(txns, { includeExcluded: !!filters.category });
  const all = aggregate(allTime);
  const slots = rankSlots(all.categories);

  const categories = [];
  let other = 0, otherCount = 0;
  for (const [category, amount] of agg.categories) {
    if (amount <= 0) continue;
    const subSlots = rankSlots(all.subs.get(category) || []);
    const subs = [...(agg.subs.get(category) || [])]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([c, v]) => ({ category: c, amount: round2(v), slot: subSlots.get(c) || 0 }));
    if (slots.has(category)) categories.push({ category, amount: round2(amount), slot: slots.get(category), subs });
    else { other += amount; otherCount += 1; }
  }
  categories.sort((a, b) => b.amount - a.amount);
  if (other > 0) categories.push({ category: 'OTHER', amount: round2(other), slot: 0, categories: otherCount, subs: [] });

  res.json({
    income: round2(agg.income),
    spending: round2(agg.spending),
    net: round2(agg.income - agg.spending),
    count: agg.counted,
    excluded: txns.length - agg.counted,
    months: [...agg.months.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, income: round2(m.income), spending: round2(m.spending) })),
    categories,
    merchants: [...agg.merchants.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8)
      .map((m) => ({ ...m, amount: round2(m.amount) })),
  });
});

// --------------------------------------------------------------- budgets --
// A budget is a monthly limit for a parent category (covering all of its
// subcategories) or a single subcategory. "Income" is the expected income.
const isBudgetable = (c) => isKnownCategory(c) && (c === 'Income' || (!isExcluded(c) && !isIncome(c) && c !== UNCATEGORIZED));

app.get('/api/budgets', async (_req, res) => res.json(await store.listBudgets()));

app.put('/api/budgets/:category', async (req, res) => {
  const { category } = req.params;
  const amount = Number(req.body?.amount);
  if (!isBudgetable(category)) return res.status(400).json({ error_message: 'Invalid category' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return res.status(400).json({ error_message: 'Amount must be a positive number' });
  await store.setBudget(category, round2(amount));
  res.json({ category, amount: round2(amount) });
});

app.delete('/api/budgets/:category', async (req, res) => {
  if (!isKnownCategory(req.params.category)) return res.status(400).json({ error_message: 'Invalid category' });
  await store.deleteBudget(req.params.category);
  res.json({ ok: true });
});

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(days).padStart(2, '0')}`;
  const today = isoDate(new Date());
  // How far through the month we are: 0..1, for the "today" marker on budget bars.
  const progress = today < start ? 0 : today > end ? 1 : Number(today.slice(8, 10)) / days;
  return { start, end, progress };
}

async function budgetSummary(month) {
  const { start, end, progress } = monthBounds(month);
  const [txns, budgets] = await Promise.all([allTransactions({ start, end }), store.listBudgets()]);
  const agg = aggregate(txns);
  const budgetOf = new Map(budgets.map((b) => [b.category, b.amount]));
  const spentOn = (c) => {
    if (parentOf(c) === c) return [...(agg.subs.get(c) || [])].reduce((s, [, v]) => s + v, 0);
    return agg.subs.get(parentOf(c))?.get(c) || 0;
  };
  const spending = budgets
    .filter((b) => b.category !== 'Income')
    .map((b) => ({ category: b.category, parent: parentOf(b.category), budget: b.amount, spent: round2(Math.max(0, spentOn(b.category))) }))
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget);
  // Spending no budget covers (a parent budget covers its subcategories).
  let unbudgeted = 0;
  for (const [parent, subs] of agg.subs) for (const [c, v] of subs) if (!budgetOf.has(c) && !budgetOf.has(parent)) unbudgeted += v;
  // Don't count a subcategory budget twice when its parent has a budget too.
  const budgetedSpending = spending.filter((b) => b.parent === b.category || !budgetOf.has(b.parent)).reduce((s, b) => s + b.budget, 0);
  return {
    month,
    progress,
    income: { actual: round2(agg.income), budget: budgetOf.get('Income') ?? null },
    spending,
    unbudgeted: round2(Math.max(0, unbudgeted)),
    totals: {
      income: round2(agg.income),
      spending: round2(agg.spending),
      budgetedIncome: budgetOf.get('Income') ?? null,
      budgetedSpending: round2(budgetedSpending),
      leftOver: round2(agg.income - agg.spending),
    },
  };
}

const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
app.get('/api/budget-summary', async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : isoDate(new Date()).slice(0, 7);
  res.json(await budgetSummary(month));
});

// ------------------------------------------------- spending pace & worth --
// This month's spending so far, day by day, against last month's.
function spendingByDay(txns) {
  const byDay = new Map();
  for (const t of txns) {
    if (t.excluded || isIncome(t.category)) continue;
    const d = Number(t.date.slice(8, 10));
    byDay.set(d, (byDay.get(d) || 0) + t.amount);
  }
  return byDay;
}
const cumulative = (byDay, days) => {
  let run = 0;
  return Array.from({ length: days }, (_, i) => round2((run += byDay.get(i + 1) || 0)));
};
const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

app.get('/api/spending-pace', async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : isoDate(new Date()).slice(0, 7);
  const prev = prevMonth(month);
  const cur = monthBounds(month), last = monthBounds(prev);
  const [curTx, lastTx] = await Promise.all([allTransactions({ start: cur.start, end: cur.end }), allTransactions({ start: last.start, end: last.end })]);
  const curDays = Number(cur.end.slice(8, 10)), lastDays = Number(last.end.slice(8, 10));
  const today = isoDate(new Date());
  // Only plot this month up to today.
  const shown = today < cur.start ? 0 : today > cur.end ? curDays : Number(today.slice(8, 10));
  const current = cumulative(spendingByDay(curTx), curDays).slice(0, shown);
  const previous = cumulative(spendingByDay(lastTx), lastDays);
  const total = current.length ? current[current.length - 1] : 0;
  const sameDay = previous[Math.min(shown, lastDays) - 1] ?? 0;
  res.json({ month, previous_month: prev, days: curDays, previous_days: lastDays, current, previous, total, previous_same_day: sameDay, previous_total: previous[lastDays - 1] ?? 0, delta: round2(total - sameDay) });
});

// Record today's balance for every account (once a day is enough; later
// syncs the same day overwrite it).
async function recordSnapshots() {
  const rows = (await store.listAccounts()).filter((a) => a.current_balance != null).map((a) => ({ account_id: a.account_id, balance: a.current_balance }));
  if (rows.length) await store.saveSnapshots(isoDate(new Date()), rows);
}

const DEBT_TYPES = new Set(['credit', 'loan']);
const monthEnd = (m) => monthBounds(m).end;

// Month-end assets, debts and net worth. Real snapshots win where they exist.
// Before that, cash and card balances are worked out backwards from their
// transactions; loans and investments can't be (interest and market moves
// aren't transactions), so they're held at their earliest known balance.
// Either way those months are marked as estimates.
app.get('/api/net-worth', async (_req, res) => {
  const [accounts, snapshots, rows] = await Promise.all([store.listAccounts(), store.listSnapshots(), categorizedTransactions()]);
  const thisMonth = isoDate(new Date()).slice(0, 7);
  const firstTx = rows.length ? rows[rows.length - 1].date.slice(0, 7) : thisMonth;
  const firstSnap = snapshots.length ? snapshots[0].date.slice(0, 7) : thisMonth;
  const months = [];
  for (let m = firstTx < firstSnap ? firstTx : firstSnap; m <= thisMonth; m = (() => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; })()) months.push(m);

  const txByAccount = new Map();
  for (const t of rows) { const l = txByAccount.get(t.account_id) || []; l.push(t); txByAccount.set(t.account_id, l); }
  const snapsByAccount = new Map();
  for (const s of snapshots) { const l = snapsByAccount.get(s.account_id) || []; l.push(s); snapsByAccount.set(s.account_id, l); }

  const out = months.map((month) => ({ month, assets: 0, debts: 0, net: 0, estimated: false }));
  for (const a of accounts) {
    if (a.current_balance == null) continue;
    const debt = DEBT_TYPES.has(a.type);
    const snaps = snapsByAccount.get(a.account_id) || [];
    const txns = txByAccount.get(a.account_id) || [];
    const reconstructable = a.type === 'depository' || a.type === 'credit';
    months.forEach((month, i) => {
      const end = monthEnd(month);
      let bal, estimated = false;
      const snap = [...snaps].reverse().find((s) => s.date <= end);
      if (month === thisMonth) bal = a.current_balance;
      else if (snap && snap.date.slice(0, 7) === month) bal = snap.balance;
      else if (reconstructable) {
        // Undo everything after month end. Plaid: positive amount = money out,
        // which lowers a cash balance and raises what you owe on a card.
        const after = txns.filter((t) => t.date > end).reduce((s, t) => s + t.amount, 0);
        bal = debt ? a.current_balance - after : a.current_balance + after;
        estimated = true; // only as good as the transaction history behind it
      } else {
        bal = (snaps[0] && snaps[0].balance) ?? a.current_balance;
        estimated = true;
      }
      const row = out[i];
      if (debt) row.debts += bal; else row.assets += bal;
      if (estimated) row.estimated = true;
    });
  }
  for (const r of out) { r.assets = round2(r.assets); r.debts = round2(r.debts); r.net = round2(r.assets - r.debts); }
  res.json({ months: out, first_snapshot: snapshots[0]?.date ?? null });
});

// ---------------------------------------------------------------- alerts --
// Computed from the data on each request, so there's nothing to keep in sync.
const pretty = (c) => (c === 'OTHER' ? 'Other' : c || UNCATEGORIZED);
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const LARGE_PURCHASE = () => Number(process.env.ALERT_LARGE_AMOUNT || 500);
const MAX_ALERTS = 12;
const acctNameOf = (a) => `${a.display_name}${a.mask ? ` ••${a.mask}` : ''}`;

app.get('/api/alerts', async (_req, res) => {
  const today = isoDate(new Date());
  const alerts = [];
  const add = (id, level, date, ...parts) => alerts.push({ id, level, date, parts: parts.map((p) => (typeof p === 'string' ? { t: p } : p)) });
  const b = (t) => ({ t, strong: true });

  // Broken bank connections.
  for (const item of await store.listItems()) {
    if (item.error) add(`item:${item.item_id}:${item.error}`, 'critical', today, b(item.institution_name), ` needs attention (${item.error}). Reconnect it from the accounts list.`);
  }

  // Budgets this month.
  const month = today.slice(0, 7);
  const summary = await budgetSummary(month);
  for (const s of summary.spending) {
    if (s.spent > s.budget) {
      add(`budget-over:${month}:${s.category}`, 'critical', today, 'This month, you spent ', b(usd(s.spent)), ' on ', b(pretty(s.category)), '. This exceeds your budget of ', b(usd(s.budget)), ` by ${usd(s.spent - s.budget)}.`);
    } else if (s.spent >= s.budget * 0.9) {
      add(`budget-near:${month}:${s.category}`, 'warning', today, `You've used ${Math.round((s.spent / s.budget) * 100)}% of your `, b(pretty(s.category)), ' budget (', b(usd(s.spent)), ` of ${usd(s.budget)}).`);
    }
  }

  // Unusual spending: last 30 days vs the 30-day average of the 90 days before
  // that. Only once the history reaches back that far, or "usual" is understated.
  const priorTxns = await allTransactions({ start: daysAgo(119), end: daysAgo(30) });
  const historyCoversPrior = priorTxns.length && priorTxns[priorTxns.length - 1].date <= daysAgo(112);
  const recent = aggregate(historyCoversPrior ? await allTransactions({ start: daysAgo(29), end: today }) : []);
  const prior = aggregate(priorTxns);
  for (const [cat, spent] of recent.categories) {
    const usual = (prior.categories.get(cat) || 0) / 3;
    if (usual >= 20 && spent >= usual * 1.5 && spent - usual >= 50) {
      add(`unusual:${today}:${cat}`, 'warning', today, 'In the past 30 days, you spent ', b(usd(spent)), ' on ', b(pretty(cat)), `. Usually you spend ${usd(usual)}.`);
    }
  }

  // Manual accounts that haven't had a CSV import in a while.
  for (const a of (await listAccounts()).filter((x) => x.manual && x.stale)) {
    const when = a.last_imported_at ? `hasn't been updated in ${a.days_since_import} days` : 'has never been imported';
    add(`stale:${a.account_id}:${a.last_imported_at || 'never'}`, 'warning', today, b(acctNameOf(a)), ` ${when}. `,
      ...(a.login_url ? [{ t: 'Log in', href: a.login_url }, ', download your transactions, then '] : ['Download your transactions, then ']),
      { t: 'import the CSV', action: 'import', account_id: a.account_id });
  }

  // Large purchases and income in the last week.
  const accounts = new Map((await listAccounts()).map((a) => [a.account_id, a]));
  const acctName = (id) => (accounts.has(id) ? acctNameOf(accounts.get(id)) : 'your account');
  for (const t of await allTransactions({ start: daysAgo(6), end: today })) {
    if (t.excluded) continue;
    if (isIncome(t.category) && t.amount < 0) {
      add(`income:${t.transaction_id}`, 'good', t.date, 'You received ', b(usd(-t.amount)), ' from ', b(merchantOf(t)), ' in ', b(acctName(t.account_id)), '.');
    } else if (t.amount >= LARGE_PURCHASE()) {
      add(`large:${t.transaction_id}`, 'info', t.date, 'Your ', b(usd(t.amount)), ' purchase from ', b(merchantOf(t)), t.pending ? ' is pending on ' : ' has cleared on ', b(acctName(t.account_id)), '.');
    }
  }

  const rank = { critical: 0, warning: 1, info: 2, good: 3 };
  alerts.sort((x, y) => rank[x.level] - rank[y.level] || y.date.localeCompare(x.date));
  res.json(alerts.slice(0, MAX_ALERTS));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error_message: 'Internal error' });
});

const SYNC_INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS ?? 6);

// Budgets, fixes and rules saved before the Mint-style tree used Plaid's
// category names (FOOD_AND_DRINK…). Convert them once; safe to re-run.
async function migrateLegacyCategories() {
  let changed = 0;
  for (const b of await store.listBudgets()) {
    if (isKnownCategory(b.category)) continue;
    const to = fromLegacy(b.category);
    const have = new Set((await store.listBudgets()).map((x) => x.category));
    if (to && !have.has(to)) await store.setBudget(to, b.amount);
    await store.deleteBudget(b.category);
    changed += 1;
  }
  for (const o of await store.listOverrides()) {
    if (isKnownCategory(o.category)) continue;
    await store.setOverride(o.transaction_id, fromLegacy(o.category) || UNCATEGORIZED);
    changed += 1;
  }
  for (const r of await store.listTxRules()) {
    if (!r.category || isKnownCategory(r.category)) continue;
    await store.saveTxRule({ ...r, category: fromLegacy(r.category) || UNCATEGORIZED });
    changed += 1;
  }
  // Old one-field rules ("contains X → category") become full rules.
  let position = 0;
  for (const r of await store.listRules()) {
    await store.saveTxRule({
      id: crypto.randomUUID(), position: position++, match_type: 'contains', pattern: r.pattern, account_id: null,
      amount_min: null, amount_max: null, rename_to: null, category: fromLegacy(r.category) || UNCATEGORIZED, start_date: null,
    });
    await store.deleteRule(r.pattern);
    changed += 1;
  }
  if (changed) console.log(`migrated ${changed} saved budgets, fixes and rules to the new categories`);
}

async function initDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.init();
      await migrateLegacyCategories();
      await recordSnapshots().catch((err) => console.error('snapshot failed', err.message));
      dbReady = true;
      console.log('database ready');
      return;
    } catch (err) {
      const delay = Math.min(30, 2 ** attempt);
      console.error(`database init failed (attempt ${attempt}): ${err.message}; retrying in ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
}

app.listen(PORT, () => console.log(`my-mint listening on :${PORT} (Plaid ${PLAID_ENV})`));
initDatabase().then(() => {
  if (SYNC_INTERVAL_HOURS > 0) {
    setInterval(() => {
      syncAll()
        .then((r) => console.log('background sync', JSON.stringify(r.map(({ error, ...x }) => (error ? { ...x, error: error.error_code } : x)))))
        .catch((err) => console.error('background sync failed', err));
    }, SYNC_INTERVAL_HOURS * 3600 * 1000).unref();
  }
});
