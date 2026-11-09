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
app.disable('x-powered-by'); // don't advertise the framework

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

// Requests that change data must come from this app's own pages. The browser
// sends the saved password with any request to this site, so without this a
// page elsewhere could try to make changes on your behalf (CSRF).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error_message: 'Cross-site request blocked' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== req.get('host')) return res.status(403).json({ error_message: 'Cross-site request blocked' });
  }
  next();
});

app.get('/healthz', (_req, res) => res.send('ok'));

// Icons are served without auth: browsers and iOS home screens fetch them
// without credentials, and they contain no data.
// Older iPhones ask for the "-precomposed" name at the site root, so it serves the same file.
const PUBLIC_ICONS = {
  '/favicon.ico': 'favicon.ico', '/favicon.svg': 'favicon.svg',
  '/apple-touch-icon.png': 'apple-touch-icon.png', '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png',
  '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/manifest.webmanifest': 'manifest.webmanifest',
};
app.get(Object.keys(PUBLIC_ICONS), (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  if (req.path.endsWith('.webmanifest')) res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', PUBLIC_ICONS[req.path]));
});

// Lock out an IP after too many wrong passwords.
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first }
// Forget expired lockouts, so addresses that never come back don't pile up.
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of failures) if (now - r.first > LOCKOUT_MS) failures.delete(ip);
}, LOCKOUT_MS).unref();
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
// Bodies are parsed only after the password check, so nobody can make the
// server parse large uploads without signing in.
app.use(express.json({ limit: '5mb' })); // CSV imports can be thousands of rows

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
      // The sync only lists checking, savings and cards; /accounts/get has every
      // account (investments, loans, HSAs) with its balance.
      try { accounts = (await plaid.accountsGet({ access_token: item.access_token })).data.accounts; }
      catch (err) { console.error('accounts get', plaidError(err).error_code); }
      await store.applySync(item.item_id, { accounts, added, modified, removed, cursor });
      bumpData();
      // When the bank's permission runs out (some banks expire it every 12–24 months).
      try { await store.setItemConsentExpiry(item.item_id, (await plaid.itemGet({ access_token: item.access_token })).data.item?.consent_expiration_time || null); }
      catch (err) { console.error('item get', plaidError(err).error_code); }
      const investments = await syncInvestments(item, accounts, cursor);
      const cards = await syncLiabilities(item, accounts);
      return { added: added.length, modified: modified.length, removed: removed.length, ...(investments ? { investments } : {}), ...(cards ? { cards } : {}) };
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
        results.push({ item_id: item.item_id, institution: item.institution_name, ...(await syncItem(item)) });
      } catch (err) {
        results.push({ item_id: item.item_id, institution: item.institution_name, error: plaidError(err) });
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
      // Every reconnect asks for both optional products (consent is free; Plaid
      // bills only when we fetch), so a bank never needs a second OK later,
      // and lets you pick accounts opened since you linked it.
      request.additional_consented_products = [Products.Investments, Products.Liabilities];
      request.update = { account_selection_enabled: true };
    } else {
      request.products = [Products.Transactions];
      request.transactions = { days_requested: 730 };
      // Ask up front, so holdings and card statements don't need a second OK later.
      request.additional_consented_products = [Products.Investments, Products.Liabilities];
    }
    // A product that isn't enabled on the Plaid account fails the whole request,
    // so try with fewer extra products. (Creating a link token changes nothing.)
    const extras = request.additional_consented_products || [];
    const attempts = [extras, ...extras.map((p) => [p]), []].filter((a, i, all) => all.findIndex((b) => b.join() === a.join()) === i);
    let data, lastErr;
    for (const products of attempts) {
      try {
        if (products.length) request.additional_consented_products = products; else delete request.additional_consented_products;
        ({ data } = await plaid.linkTokenCreate(request));
        break;
      } catch (err) {
        lastErr = err;
        if (!products.length) throw err;
      }
    }
    if (!data) throw lastErr;
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
  res.json((await store.listItems()).map(({ access_token, cursor, ...rest }) => ({
    ...rest,
    manual: isManualItem(rest),
    ...(rest.error === CONSENT_NEEDED ? { consent_for: consentFor(rest) } : {}),
    expires_in_days: expiresInDays(rest),
  })));
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
  bumpData(); // account names appear in cached results (bills)
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

// ----------------------------------------------------------- investments --
// Holdings and investment activity come from Plaid's Investments product, and
// only for banks that actually have investment accounts (it's billed per bank).
const INVESTMENT_TYPES = new Set(['investment', 'brokerage']);
// Each bank's result for the optional products, saved with the bank
// (items.product_status) so a restart doesn't forget it: null = working,
// otherwise Plaid's error code. Missing = not tried yet.
const parseStatus = (item) => {
  const v = item?.product_status;
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
};
// A product's status, or the saved consent error when it hasn't been tried since.
const statusOf = (item, product) => {
  const st = parseStatus(item);
  return product in st ? st[product] : item.error === CONSENT_NEEDED ? CONSENT_NEEDED : null;
};
const CONSENT_NEEDED = 'ADDITIONAL_CONSENT_REQUIRED';

async function syncInvestments(item, accounts, cursor) {
  const invIds = new Set(accounts.filter((a) => INVESTMENT_TYPES.has(a.type)).map((a) => a.account_id));
  if (!invIds.size) return null;
  try {
    const { data: h } = await plaid.investmentsHoldingsGet({ access_token: item.access_token });
    const sec = new Map(h.securities.map((x) => [x.security_id, x]));
    await store.replaceHoldings(item.item_id, h.holdings.map((x) => {
      const s = sec.get(x.security_id) || {};
      return {
        account_id: x.account_id, security_id: x.security_id,
        ticker: s.ticker_symbol || null, name: s.name || 'Unknown security', type: s.is_cash_equivalent ? 'cash' : s.type || 'other',
        quantity: x.quantity, price: x.institution_price, value: x.institution_value, cost_basis: x.cost_basis ?? null,
        iso_currency_code: x.iso_currency_code || s.iso_currency_code || 'USD',
      };
    }));
    // Activity: two years the first time, then the last 90 days (it isn't incremental like /transactions/sync).
    const have = (await categorizedTransactions()).some((t) => invIds.has(t.account_id) && t.plaid_category === 'INVESTMENT');
    const end = isoDate(new Date()), start = daysAgo(have ? 90 : 730);
    const txns = [];
    for (let offset = 0, total = Infinity; offset < total; ) {
      const { data } = await plaid.investmentsTransactionsGet({ access_token: item.access_token, start_date: start, end_date: end, options: { count: 500, offset } });
      total = data.total_investment_transactions;
      const sec2 = new Map(data.securities.map((x) => [x.security_id, x]));
      for (const t of data.investment_transactions) {
        const s = sec2.get(t.security_id);
        txns.push({
          transaction_id: t.investment_transaction_id, account_id: t.account_id, date: t.date, name: t.name,
          merchant_name: s?.ticker_symbol ? `${s.ticker_symbol}${s.name ? ` · ${s.name}` : ''}` : null,
          amount: t.amount, iso_currency_code: t.iso_currency_code || 'USD', pending: false,
          personal_finance_category: { primary: 'INVESTMENT', detailed: `INVESTMENT_${t.type}_${t.subtype || t.type}`.toUpperCase().replace(/\s+/g, '_') },
        });
      }
      if (!data.investment_transactions.length) break;
      offset += data.investment_transactions.length;
    }
    if (txns.length) await store.applySync(item.item_id, { accounts: [], added: txns, modified: [], removed: [], cursor });
    await store.setItemProductStatus(item.item_id, 'investments', null);
    bumpData();
    return { holdings: h.holdings.length, activity: txns.length };
  } catch (err) {
    return productError(item, 'investments', err);
  }
}

// Optional products (Investments, Liabilities) fail on their own without
// breaking the sync. The bank may want your OK first: "reconnect" asks for it.
async function productError(item, product, err) {
  const code = err.response?.data?.error_code || err.message;
  await store.setItemProductStatus(item.item_id, product, code);
  if (code === CONSENT_NEEDED) await store.setItemError(item.item_id, CONSENT_NEEDED);
  else console.error(product, item.institution_name, code);
  return { error: code };
}

// Days until a bank's permission to share runs out (null when it doesn't expire).
const EXPIRY_WARN_DAYS = () => Number(process.env.CONSENT_WARN_DAYS || 30);
function expiresInDays(item) {
  if (!item.consent_expires_at) return null;
  return Math.ceil((new Date(item.consent_expires_at).getTime() - Date.now()) / 86400000);
}

// What a bank still needs your OK to share, in a few words.
function consentFor(item) {
  const st = parseStatus(item);
  const inv = st.investments === CONSENT_NEEDED, card = st.liabilities === CONSENT_NEEDED;
  if (inv && !card) return 'investment details';
  if (card && !inv) return 'card statements';
  return 'card statements and investments';
}

// ---------------------------------------------------------- liabilities --
// Credit card statements (statement balance, due date, minimum, APRs) from
// Plaid's Liabilities product, only for banks with credit cards.

async function syncLiabilities(item, accounts) {
  if (!accounts.some((a) => a.type === 'credit' || a.type === 'loan')) return null;
  try {
    const { data } = await plaid.liabilitiesGet({ access_token: item.access_token });
    const L = data.liabilities || {};
    const loans = [
      ...(L.mortgage || []).filter((m) => m.account_id).map((m) => ({
        kind: 'mortgage', account_id: m.account_id,
        rate: m.interest_rate?.percentage ?? null, rate_type: m.interest_rate?.type ?? null,
        next_payment: m.next_monthly_payment ?? null, next_due_date: m.next_payment_due_date ?? null,
        last_payment_amount: m.last_payment_amount ?? null, last_payment_date: m.last_payment_date ?? null,
        maturity_date: m.maturity_date ?? null, origination_date: m.origination_date ?? null,
        original_principal: m.origination_principal_amount ?? null, loan_term: m.loan_term ?? null,
        loan_type: m.loan_type_description ?? null, escrow_balance: m.escrow_balance ?? null,
        has_pmi: m.has_pmi ?? null, has_prepayment_penalty: m.has_prepayment_penalty ?? null,
        past_due: m.past_due_amount ?? null, ytd_interest: m.ytd_interest_paid ?? null, ytd_principal: m.ytd_principal_paid ?? null,
      })),
      ...(L.student || []).filter((x) => x.account_id).map((x) => ({
        kind: 'student', account_id: x.account_id,
        rate: x.interest_rate_percentage ?? null, next_payment: x.minimum_payment_amount ?? null, next_due_date: x.next_payment_due_date ?? null,
        last_payment_amount: x.last_payment_amount ?? null, last_payment_date: x.last_payment_date ?? null,
        maturity_date: x.expected_payoff_date ?? null, origination_date: x.origination_date ?? null,
        original_principal: x.origination_principal_amount ?? null, loan_type: x.loan_name ?? null,
        ytd_interest: x.ytd_interest_paid ?? null, ytd_principal: x.ytd_principal_paid ?? null,
        outstanding_interest: x.outstanding_interest_amount ?? null, past_due: null,
      })),
    ];
    const rows = (L.credit || []).filter((c) => c.account_id).map((c) => ({
      kind: 'credit',
      account_id: c.account_id,
      statement_balance: c.last_statement_balance ?? null,
      statement_date: c.last_statement_issue_date ?? null,
      due_date: c.next_payment_due_date ?? null,
      minimum_payment: c.minimum_payment_amount ?? null,
      last_payment_amount: c.last_payment_amount ?? null,
      last_payment_date: c.last_payment_date ?? null,
      is_overdue: c.is_overdue ?? null,
      aprs: (c.aprs || []).map((a) => ({ type: a.apr_type, apr: a.apr_percentage, balance: a.balance_subject_to_apr ?? null, interest: a.interest_charge_amount ?? null })),
    }));
    await store.replaceCardStatements(item.item_id, [...rows, ...loans]);
    await store.setItemProductStatus(item.item_id, 'liabilities', null);
    return { statements: rows.length, loans: loans.length };
  } catch (err) {
    return productError(item, 'liabilities', err);
  }
}

app.get('/api/investments', async (_req, res) => {
  const [accounts, holdings, itemList] = await Promise.all([listAccounts(), store.listHoldings(), store.listItems()]);
  const invAccounts = accounts.filter((a) => INVESTMENT_TYPES.has(a.type));
  const byAccount = new Map();
  for (const h of holdings) { const l = byAccount.get(h.account_id) || []; l.push(h); byAccount.set(h.account_id, l); }
  const allocation = new Map();
  let value = 0, costed = 0, cost = 0;
  const out = invAccounts.map((a) => {
    const hs = (byAccount.get(a.account_id) || []).map((h) => ({ ...h, gain: h.cost_basis != null && h.value != null ? round2(h.value - h.cost_basis) : null }));
    for (const h of hs) {
      allocation.set(h.type, (allocation.get(h.type) || 0) + (h.value || 0));
      if (h.cost_basis != null && h.value != null) { costed += h.value; cost += h.cost_basis; }
    }
    value += a.current_balance || 0;
    return { account_id: a.account_id, name: acctNameOf(a), institution: a.institution_name, item_id: a.item_id, balance: a.current_balance, holdings: hs, updated_at: hs[0]?.updated_at ?? null };
  });
  const status = itemList
    .filter((i) => invAccounts.some((a) => a.item_id === i.item_id))
    .map((i) => ({ item_id: i.item_id, institution: i.institution_name, status: statusOf(i, 'investments') }));
  res.json({
    accounts: out,
    value: round2(value),
    cost_basis: round2(cost),
    gain: round2(costed - cost),
    gain_pct: cost > 0 ? round2(((costed - cost) / cost) * 100) : null,
    allocation: [...allocation].map(([type, v]) => ({ type, value: round2(v) })).sort((a, b) => b.value - a.value),
    status,
  });
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

// ------------------------------------------------------- recurring bills --
// Detected from your own history (works for manual accounts too): for each
// merchant, look for a regular rhythm. A merchant that bills two different
// things on different days (e.g. $267 and $23.50 every month) is split by
// amount and each is checked on its own.
const FREQUENCIES = [
  { key: 'weekly', label: 'Weekly', days: 7, tol: 2 },
  { key: 'biweekly', label: 'Every 2 weeks', days: 14, tol: 3 },
  { key: 'monthly', label: 'Monthly', days: 30.44, tol: 5 },
  { key: 'quarterly', label: 'Quarterly', days: 91.3, tol: 12 },
  { key: 'yearly', label: 'Yearly', days: 365.25, tol: 20 },
];
const SKIP_RECURRING = new Set(['Transfer for Cash Requirement', 'Loan Payment Received', 'Hide from Budgets & Trends', 'Transfer']);
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
const fromDayNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

function addPeriod(date, f, n = 1) {
  if (f.key === 'monthly' || f.key === 'quarterly' || f.key === 'yearly') {
    const months = (f.key === 'monthly' ? 1 : f.key === 'quarterly' ? 3 : 12) * n;
    const [y, m, d] = date.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }
  return fromDayNum(dayNum(date) + f.days * n);
}

// Places where two visits a year apart are a coincidence, not a bill.
const NOT_YEARLY = new Set(['Food & Dining', 'Travel', 'Shopping', 'Gifts & Donations', 'Entertainment', 'Personal Care']);

// Is this list of transactions (oldest first) a regular series?
function cadence(txns) {
  if (txns.length < 2) return null;
  const gaps = txns.slice(1).map((t, i) => dayNum(t.date) - dayNum(txns[i].date)).filter((g) => g > 0);
  if (!gaps.length) return null;
  const g = median(gaps);
  const f = FREQUENCIES.find((x) => Math.abs(g - x.days) <= x.tol);
  if (!f) return null;
  if (f.key !== 'yearly' && txns.length < 3) return null;
  if (f.key === 'yearly' && txns.length < 3) {
    // Two charges a year apart only count as a yearly bill when the amount
    // repeats (a renewal) and it isn't somewhere you'd just happen to go twice.
    const [a, b] = txns.map((t) => t.amount);
    if (Math.abs(a - b) > Math.max(0.5, 0.02 * a) || a < 5 || NOT_YEARLY.has(txns[0].parent)) return null;
  }
  const regular = gaps.filter((x) => Math.abs(x - f.days) <= f.tol).length / gaps.length;
  return regular >= 0.7 ? f : null;
}

// Split amounts into clusters of similar size (within 15% of the cluster's first amount).
function amountClusters(txns) {
  const sorted = [...txns].sort((a, b) => a.amount - b.amount);
  const clusters = [];
  for (const t of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && t.amount <= c[0].amount * 1.15 + 1) c.push(t); else clusters.push([t]);
  }
  return clusters.map((c) => c.sort((a, b) => a.date.localeCompare(b.date)));
}

// Detection reads every transaction, and Overview, Bills, alerts and the card
// plan all ask for it, so keep the answer until the data (or the day) changes.
let recurringCache = null;
async function detectRecurring() {
  const key = `${dataVersion}|${isoDate(new Date())}`;
  if (recurringCache?.key !== key) recurringCache = { key, bills: detectRecurringNow() };
  try {
    return structuredClone(await recurringCache.bills);
  } catch (err) {
    recurringCache = null; // don't keep a failure
    throw err;
  }
}

async function detectRecurringNow() {
  const rows = await categorizedTransactions();
  const accounts = new Map((await listAccounts()).map((a) => [a.account_id, a]));
  const today = isoDate(new Date());
  // Money back by account, to spot charges the bank reverses every time
  // (a monthly fee that's always waived costs nothing).
  const credits = new Map();
  for (const t of rows) if (t.amount < 0) { const l = credits.get(t.account_id) || []; l.push(t); credits.set(t.account_id, l); }
  const reversed = (t) => (credits.get(t.account_id) || []).some((c) => Math.abs(c.amount + t.amount) < 0.01 && Math.abs(dayNum(c.date) - dayNum(t.date)) <= 3);
  const groups = new Map();
  for (const t of rows) {
    if (t.amount <= 0 || t.pending || SKIP_RECURRING.has(t.category) || (t.excluded && t.category !== 'Credit Card Payment')) continue;
    const key = (t.display_name || merchantKey(t) || t.name).toLowerCase();
    // Checks to different people all look alike; only a rule's name tells them apart.
    if (!key || (!t.display_name && /^check\b/.test(key))) continue;
    const l = groups.get(key) || [];
    l.push(t);
    groups.set(key, l);
  }
  const bills = [];
  for (const [key, all] of groups) {
    const series = all.sort((a, b) => a.date.localeCompare(b.date));
    // Whole merchant first (variable bills like electricity), then by amount.
    let found = cadence(series) ? [series] : amountClusters(series).filter((c) => cadence(c));
    for (const txns of found) {
      const f = cadence(txns);
      const last = txns[txns.length - 1];
      if (txns.filter(reversed).length >= txns.length * 0.7) continue;
      // Stopped if it's well past when the next one should have come.
      if (dayNum(today) - dayNum(last.date) > f.days * 1.5 + f.tol) continue;
      const recent = txns.slice(-3).map((t) => t.amount);
      const typical = median(recent);
      const spread = (Math.max(...recent) - Math.min(...recent)) / (typical || 1);
      let next = addPeriod(last.date, f);
      const a = accounts.get(last.account_id);
      bills.push({
        id: crypto.createHash('sha1').update(`${key}|${f.key}|${Math.round(typical)}`).digest('hex').slice(0, 12),
        name: last.display_name || last.merchant_name || last.name,
        category: last.category,
        parent: last.parent,
        card_payment: last.category === 'Credit Card Payment',
        frequency: f.key,
        frequency_label: f.label,
        amount: round2(typical),
        variable: spread > 0.15,
        monthly: round2((typical * 30.44) / f.days),
        last_date: last.date,
        next_date: next,
        overdue: next < today,
        occurrences: txns.length,
        account: a ? acctNameOf(a) : null,
        account_id: last.account_id,
        history: txns.slice(-6).map((t) => ({ date: t.date, amount: t.amount })),
      });
    }
  }
  bills.sort((a, b) => a.next_date.localeCompare(b.next_date));
  return bills;
}

app.get('/api/recurring', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
  const bills = await detectRecurring();
  const horizon = daysAgo(-days);
  const upcoming = bills.filter((b) => b.next_date <= horizon);
  const counted = bills.filter((b) => !b.card_payment);
  res.json({
    bills,
    upcoming,
    days,
    monthly_total: round2(counted.reduce((s, b) => s + b.monthly, 0)),
    upcoming_total: round2(upcoming.filter((b) => !b.card_payment).reduce((s, b) => s + b.amount, 0)),
  });
});

// ------------------------------------------------------- expected income --
// Paychecks found the same way as bills: deposits into checking, in an Income
// category, grouped by payer, on a regular rhythm. Twice a month (the 1st and
// 15th) is found from the days of the month, since the gaps alone look like
// every 2 weeks.
function semimonthly(txns) {
  if (txns.length < 4) return null;
  const gaps = txns.slice(1).map((t, i) => dayNum(t.date) - dayNum(txns[i].date));
  if (median(gaps) < 12 || median(gaps) > 18) return null;
  const days = txns.slice(-6).map((t) => Number(t.date.slice(8, 10))).sort((a, b) => a - b);
  const groups = [];
  for (const d of days) { const g = groups.find((x) => Math.abs(x[0] - d) <= 3); if (g) g.push(d); else groups.push([d]); }
  if (groups.length !== 2 || groups.some((g) => g.length < 2)) return null;
  return groups.map((g) => Math.round(median(g)));
}

function nextOnDays(date, days) {
  // The next date after `date` falling on one of these days of the month.
  const [y, m] = date.split('-').map(Number);
  for (let k = 0; k < 3; k++) {
    for (const d of days) {
      const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
      const c = new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
      if (c > date) return c;
    }
  }
  return null;
}

async function detectIncome(accountIds) {
  const today = isoDate(new Date());
  const groups = new Map();
  for (const t of await categorizedTransactions()) {
    if (t.amount >= 0 || t.pending || t.excluded || !isIncome(t.category) || !accountIds.has(t.account_id)) continue;
    const key = (t.display_name || merchantKey(t) || t.name || '').toLowerCase();
    if (!key) continue;
    const l = groups.get(key) || [];
    l.push({ ...t, amount: -t.amount });
    groups.set(key, l);
  }
  const out = [];
  for (const all of groups.values()) {
    const series = all.sort((a, b) => a.date.localeCompare(b.date));
    const found = cadence(series) || semimonthly(series) ? [series] : amountClusters(series).filter((c) => cadence(c));
    for (const txns of found) {
      const last = txns[txns.length - 1];
      const semi = semimonthly(txns);
      const f = semi ? { key: 'semimonthly', label: 'Twice a month', days: 15.22, tol: 4 } : cadence(txns);
      if (!f || f.key === 'yearly' || f.key === 'quarterly') continue;
      if (dayNum(today) - dayNum(last.date) > f.days * 1.5 + f.tol) continue; // stopped
      out.push({
        name: last.display_name || last.merchant_name || last.name,
        frequency: f.key, frequency_label: f.label,
        amount: round2(median(txns.slice(-3).map((t) => t.amount))),
        last_date: last.date,
        next: (d) => (semi ? nextOnDays(d, semi) : addPeriod(d, f)),
      });
    }
  }
  return out;
}

// ------------------------------------------------------ credit card plan --
// Checking (all checking accounts together) pays the bills due before each
// card's due date, keeps a buffer, and the rest goes to the cards: first every
// minimum, then statement balances, highest APR first (a 0% promo last).
// Paychecks arriving before a due date count toward that card.
const CHECKING_SUBTYPES = new Set(['checking', 'cash management', 'prepaid', 'paypal']);
const SAVINGS_SUBTYPES = new Set(['savings', 'money market']);
const TAXABLE_INVESTMENT_SUBTYPES = new Set(['brokerage', 'mutual fund', 'stock plan', 'non-taxable brokerage account']);
const PLAN_BUFFER = () => Number(process.env.CARD_PLAN_BUFFER || 500);
const DEFAULT_APR = () => Number(process.env.CARD_PLAN_DEFAULT_APR || 24);
const INVEST_THRESHOLD = () => Number(process.env.CARD_PLAN_INVEST_THRESHOLD || 25000);
const MAX_HORIZON = 45;

function cashKind(a) {
  if (a.type !== 'depository') return null;
  const sub = (a.subtype || '').toLowerCase();
  if (SAVINGS_SUBTYPES.has(sub) || (!sub && /saving|money market/i.test(`${a.name} ${a.display_name}`))) return 'savings';
  if (CHECKING_SUBTYPES.has(sub) || !sub) return 'checking';
  return null; // CDs, HSAs: not spending money
}

const isCardPayment = (t) => t.category === 'Credit Card Payment' || t.category_detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' || t.parent === 'Transfer';

// The card's details: Plaid's statement unless yours is newer; your APR and promo win.
function cardDetails(a, st, us, today) {
  const mine = us.statement_date && (!st?.statement_date || us.statement_date > st.statement_date);
  const src = mine ? us : st || {};
  const purchase = st?.aprs?.find((x) => x.type === 'purchase_apr');
  const plaidApr = purchase?.apr ?? (st?.aprs?.length ? Math.max(...st.aprs.map((x) => x.apr ?? 0)) : null);
  const promoActive = us.promo_apr != null && (!us.promo_end || us.promo_end >= today);
  const regularApr = us.apr ?? (plaidApr || null);
  return {
    source: mine ? 'you' : st ? 'plaid' : null,
    statement_balance: src.statement_balance ?? null,
    statement_date: src.statement_date ?? null,
    due_date: src.due_date ?? us.due_date ?? null,
    minimum_payment: src.minimum_payment ?? us.minimum_payment ?? null,
    last_payment_amount: st?.last_payment_amount ?? null,
    last_payment_date: st?.last_payment_date ?? null,
    aprs: st?.aprs || [],
    apr: promoActive ? us.promo_apr : regularApr ?? (plaidApr === 0 ? 0 : null),
    regular_apr: regularApr,
    promo: promoActive ? { apr: us.promo_apr, end: us.promo_end || null } : plaidApr === 0 && us.apr == null ? { apr: 0, end: null, from_plaid: true } : null,
  };
}

async function cardPlan({ buffer }) {
  const today = isoDate(new Date());
  const [accounts, statements, settings, txns, bills, holdings] = await Promise.all([
    listAccounts(), store.listCardStatements(), store.listCardSettings(), categorizedTransactions(), detectRecurring(), store.listHoldings(),
  ]);
  const st = new Map(statements.map((x) => [x.account_id, x]));
  const us = new Map(settings.map((x) => [x.account_id, x]));
  const checking = accounts.filter((a) => cashKind(a) === 'checking');
  const savings = accounts.filter((a) => cashKind(a) === 'savings');
  const checkingIds = new Set(checking.map((a) => a.account_id));
  const cash = round2(checking.reduce((s, a) => s + (a.available_balance ?? a.current_balance ?? 0), 0));

  // Cards and what's still owed on each statement.
  const cards = accounts.filter((a) => a.type === 'credit').map((a) => {
    const d = cardDetails(a, st.get(a.account_id), us.get(a.account_id) || {}, today);
    const paidTx = d.statement_date
      ? txns.filter((t) => t.account_id === a.account_id && t.amount < 0 && t.date > d.statement_date && isCardPayment(t)).reduce((s, t) => s - t.amount, 0)
      : 0;
    // A payment Plaid knows about that isn't in the card's transactions yet.
    const paid = round2(paidTx || (d.last_payment_date && d.statement_date && d.last_payment_date > d.statement_date ? d.last_payment_amount || 0 : 0));
    const remaining = d.statement_balance == null ? null : round2(Math.max(0, d.statement_balance - paid));
    const minimum = remaining == null ? null : round2(Math.min(remaining, Math.max(0, (d.minimum_payment ?? Math.max(35, remaining * 0.02)) - paid)));
    const aprAssumed = d.apr == null;
    // Utilization: what you owe as a share of the limit (a big part of a credit score).
    const limit = a.credit_limit ?? us.get(a.account_id)?.credit_limit ?? null;
    const owes = Math.max(0, a.current_balance || 0);
    // Interest: what the bank charged on the last statement, and Finance Charges on this card this year.
    const charged = st.get(a.account_id)?.aprs?.filter((x) => x.interest != null);
    const year = today.slice(0, 4);
    const ytd = txns.filter((t) => t.account_id === a.account_id && t.category === 'Finance Charge' && t.date.startsWith(year)).reduce((s, t) => s + t.amount, 0);
    return {
      credit_limit: limit,
      credit_limit_source: a.credit_limit != null ? 'bank' : limit != null ? 'you' : null,
      utilization: limit > 0 ? round2((owes / limit) * 100) : null,
      to_30: limit > 0 ? round2(Math.max(0, owes - limit * 0.3)) : null,
      interest_charged: charged?.length ? round2(charged.reduce((s, x) => s + x.interest, 0)) : null,
      interest_ytd: round2(Math.max(0, ytd)),
      account_id: a.account_id, name: acctNameOf(a), institution: a.institution_name, manual: a.manual, mine: us.get(a.account_id) || null,
      balance: a.current_balance, ...d, paid_since_statement: paid, remaining,
      minimum, minimum_estimated: d.minimum_payment == null && remaining != null,
      apr: aprAssumed ? DEFAULT_APR() : d.apr, apr_assumed: aprAssumed,
      overdue: remaining > 0 && d.due_date != null && d.due_date < today,
      needs_details: d.statement_balance == null || d.due_date == null,
      // What you could add (Edit) to make the plan exact.
      missing: (a.current_balance || 0) > 0 ? [
        ...(d.statement_balance == null || d.due_date == null ? ['statement'] : []),
        ...(aprAssumed ? ['APR'] : []),
        ...(limit == null ? ['credit limit'] : []),
      ] : [],
      promo_ending: d.promo?.end && d.promo.end <= fromDayNum(dayNum(today) + MAX_HORIZON) ? d.promo.end : null,
    };
  });

  // Days from today to the last due date we're planning for (at least 30).
  const planned = cards.filter((c) => !c.needs_details && c.remaining > 0);
  const lastDue = planned.reduce((m, c) => (c.due_date > m ? c.due_date : m), today);
  const H = Math.min(MAX_HORIZON, Math.max(30, dayNum(lastDue) - dayNum(today)));
  const end = fromDayNum(dayNum(today) + H);
  // Payments are planned up to `end`; bills and paychecks are projected a month
  // further, so a payment never takes money next month's bills need.
  const HB = H + 31;
  const through = fromDayNum(dayNum(today) + HB);
  const idx = (date) => Math.max(0, Math.min(HB, dayNum(date) - dayNum(today)));

  // Bills paid from checking (credit card payments are what we're planning) and paychecks.
  const events = [];
  for (const b of bills) {
    if (b.card_payment || !checkingIds.has(b.account_id)) continue;
    let d = b.next_date;
    if (d < daysAgo(5)) continue; // well overdue: probably stopped or paid some other way
    for (let n = 0; d <= through && n < 20; n++) {
      events.push({ date: d < today ? today : d, type: 'bill', name: b.name, amount: -b.amount, variable: b.variable });
      d = addPeriod(d, FREQUENCIES.find((f) => f.key === b.frequency));
    }
  }
  const income = await detectIncome(checkingIds);
  for (const p of income) {
    let d = p.next(p.last_date);
    for (let n = 0; d && d <= through && n < 20; n++) {
      if (d >= daysAgo(3)) events.push({ date: d < today ? today : d, type: 'income', name: p.name, amount: p.amount });
      d = p.next(d);
    }
  }
  events.sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);

  // Projected checking balance at the end of each day, before card payments.
  const bal = Array.from({ length: HB + 1 }, () => cash);
  for (const e of events) for (let i = idx(e.date); i <= HB; i++) bal[i] += e.amount;
  // The most that can go out on day t without dipping below the buffer later.
  const capacity = (t) => Math.max(0, Math.min(...bal.slice(t)) - buffer);
  const payments = [];
  const dueDay = (c) => idx(fromDayNum(Math.max(dayNum(today), dayNum(c.due_date) - 2))); // ~2 days for the payment to post
  const book = (c, t, amt, kind) => {
    for (let i = t; i <= HB; i++) bal[i] -= amt;
    payments.push({ account_id: c.account_id, day: t, amount: amt, kind });
  };
  const pay = (c, want, kind) => {
    if (want <= 0.005) return 0;
    const t = dueDay(c);
    const amt = round2(Math.min(want, capacity(t)));
    if (amt <= 0) return 0;
    book(c, t, amt, kind);
    return amt;
  };
  // After the due date: still worth paying as soon as a paycheck makes room,
  // since interest builds every day the balance is carried.
  const payLate = (c, want) => {
    let left = round2(want), total = 0;
    for (let t = dueDay(c) + 1; t <= H && left > 0.005; t++) {
      const amt = round2(Math.min(left, capacity(t)));
      if (amt <= 0.005) continue;
      book(c, t, amt, 'extra');
      left = round2(left - amt); total += amt;
    }
    return round2(total);
  };

  // 1. Every minimum, soonest due first (no late fees, no penalty APR).
  for (const c of [...planned].sort((x, y) => x.due_date.localeCompare(y.due_date))) c.pay = pay(c, c.minimum, 'minimum');
  // 2. The rest of each statement, highest APR first (a promo about to end counts
  //    as the highest). 3. Whatever couldn't be paid by the due date, as soon as
  //    there's room. 4. Statements on a 0% promo last: only the minimum is needed.
  const onPromo = (c) => c.promo && !c.promo_ending;
  const byApr = (list) => [...list].sort((x, y) => (y.promo_ending ? 1000 : y.apr) - (x.promo_ending ? 1000 : x.apr) || x.due_date.localeCompare(y.due_date));
  const interestBearing = byApr(planned.filter((c) => !onPromo(c)));
  for (const c of interestBearing) c.pay = round2(c.pay + pay(c, c.remaining - c.pay, 'statement'));
  // A missed minimum is the worst outcome (late fee, penalty APR), so catch those up first.
  for (const c of [...planned].sort((x, y) => x.due_date.localeCompare(y.due_date))) c.pay_late = payLate(c, c.minimum - c.pay);
  for (const c of interestBearing) c.pay_late = round2(c.pay_late + payLate(c, c.remaining - c.pay - c.pay_late));
  for (const c of planned.filter(onPromo).sort((x, y) => x.due_date.localeCompare(y.due_date))) c.pay = round2(c.pay + pay(c, c.remaining - c.pay, 'statement'));

  // When the money for each payment is there: today, or after a paycheck.
  const incomeDays = events.filter((e) => e.type === 'income');
  for (const c of cards) {
    c.pay ??= 0;
    c.pay_late ??= 0;
    c.unpaid = c.remaining == null ? null : round2(c.remaining - c.pay); // not paid by the due date
    const apr = c.promo && !c.promo_ending ? c.promo.apr : c.promo_ending ? c.regular_apr ?? DEFAULT_APR() : c.apr;
    // Carrying a balance costs interest on it (and ends the grace period on new
    // purchases). Late payments cut that: interest only for the days until they're paid.
    const daily = apr / 36500;
    c.interest_if_unpaid = c.remaining ? round2((c.remaining * apr) / 1200) : 0;
    const late = payments.filter((p) => p.account_id === c.account_id && p.kind === 'extra');
    const dueAt = c.due_date ? dayNum(c.due_date) : 0;
    c.interest_cost = c.unpaid
      ? round2((c.unpaid - c.pay_late) * apr / 1200 + late.reduce((s, p) => s + p.amount * daily * Math.max(0, dayNum(today) + p.day - dueAt), 0))
      : 0;
    c.pay_by = c.remaining > 0 ? c.due_date : null;
    c.payments = Object.values(payments.filter((p) => p.account_id === c.account_id).reduce((m, p) => {
      const date = fromDayNum(dayNum(today) + p.day), k = `${date}|${p.kind === 'extra'}`;
      m[k] ||= { date, amount: 0, late: p.kind === 'extra' };
      m[k].amount = round2(m[k].amount + p.amount);
      return m;
    }, {})).sort((x, y) => x.date.localeCompare(y.date));
    const mine = payments.filter((p) => p.account_id === c.account_id && p.kind !== 'extra');
    if (mine.length) {
      const t = Math.max(...mine.map((p) => p.day));
      // Earliest day it could go out instead: moving it earlier takes it out of
      // those days' balances too, and none may dip below the buffer.
      let from = t;
      while (from > 0 && bal[from - 1] - c.pay >= buffer - 0.005) from--;
      c.pay_from = fromDayNum(dayNum(today) + from);
      const paycheck = [...incomeDays].reverse().find((e) => idx(e.date) <= from && idx(e.date) > 0);
      c.funded_by = from === 0 || !paycheck ? 'checking' : { name: paycheck.name, date: paycheck.date };
    }
  }

  const totalDue = round2(planned.reduce((s, c) => s + c.remaining, 0));
  const totalPay = round2(cards.reduce((s, c) => s + c.pay, 0));
  const totalLate = round2(cards.reduce((s, c) => s + c.pay_late, 0));
  const unpaid = round2(Math.max(0, totalDue - totalPay)); // not paid by the due dates
  const minShort = round2(planned.reduce((s, c) => s + Math.max(0, c.minimum - c.pay), 0));
  const cardDebt = round2(cards.reduce((s, c) => s + Math.max(0, c.balance || 0), 0));
  const interest = round2(cards.reduce((s, c) => s + c.interest_cost, 0));
  const limited = cards.filter((c) => c.credit_limit > 0);
  const totalLimit = round2(limited.reduce((s, c) => s + c.credit_limit, 0));
  const utilization = totalLimit ? round2((limited.reduce((s, c) => s + Math.max(0, c.balance || 0), 0) / totalLimit) * 100) : null;

  // Lowest point of checking, and when. Below the buffer means the bills alone don't fit.
  const lowDay = bal.indexOf(Math.min(...bal));
  const belowBuffer = round2(Math.max(0, buffer - bal[lowDay]));
  const missedMinimums = planned.filter((c) => c.pay < c.minimum - 0.005);

  // If checking falls short: savings first, investments only with a lot of card debt.
  // Enough to keep the buffer, make every minimum on time and pay the
  // interest-bearing statements in full (a 0% promo only needs its minimum).
  const suggestions = [];
  const savingsTotal = round2(savings.reduce((s, a) => s + Math.max(0, a.available_balance ?? a.current_balance ?? 0), 0));
  let gap = round2(belowBuffer + planned.reduce((s, c) => s + Math.max(0, onPromo(c) ? c.minimum - c.pay : c.remaining - c.pay), 0));
  // Interest avoided by money put on the unpaid balances, highest APR first (shared, so it isn't counted twice).
  const owed = cards.filter((x) => x.unpaid > 0 && x.interest_cost > 0).map((c) => ({ left: c.unpaid, rate: c.interest_cost / c.unpaid })).sort((x, y) => y.rate - x.rate);
  const saved = (amount) => {
    let left = amount, out = 0;
    for (const o of owed) { const take = Math.min(left, o.left); out += take * o.rate; o.left -= take; left -= take; }
    return round2(out);
  };
  if (gap > 0 && savingsTotal > 0) {
    const amount = round2(Math.min(gap, savingsTotal));
    suggestions.push({ type: 'savings', amount, interest_saved: saved(amount), accounts: savings.map((a) => acctNameOf(a)) });
    gap = round2(gap - amount);
  }
  const taxable = accounts.filter((a) => a.type === 'investment' && TAXABLE_INVESTMENT_SUBTYPES.has((a.subtype || '').toLowerCase()));
  const taxableTotal = round2(taxable.reduce((s, a) => s + Math.max(0, a.current_balance || 0), 0));
  if (gap > 0 && cardDebt > INVEST_THRESHOLD() && taxableTotal > 0) {
    const amount = round2(Math.min(gap, taxableTotal));
    suggestions.push({ type: 'investments', amount, interest_saved: saved(amount), accounts: taxable.map((a) => acctNameOf(a)) });
  }

  // The cash timeline, with the planned payments.
  const timeline = [
    ...events,
    ...cards.flatMap((c) => c.payments.map((p) => ({ date: p.date, type: 'card', name: c.name, amount: -p.amount, late: p.late }))),
  ].sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
  let run = cash;
  for (const e of timeline) { run = round2(run + e.amount); e.balance = run; }
  const lowest = round2(Math.min(...bal));

  cards.sort((x, y) => (x.needs_details - y.needs_details) || (x.due_date || '9').localeCompare(y.due_date || '9'));
  return {
    today, end, through, buffer,
    checking: { total: cash, accounts: checking.map((a) => ({ name: acctNameOf(a), balance: a.available_balance ?? a.current_balance })) },
    savings: savingsTotal,
    income: income.map(({ next, ...p }) => { let d = next(p.last_date); while (d && d < today) d = next(d); return { ...p, next_date: d }; }),
    totals: {
      income: round2(events.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0)),
      bills: round2(-events.filter((e) => e.type === 'bill').reduce((s, e) => s + e.amount, 0)),
      due: totalDue, pay: totalPay, pay_late: totalLate, unpaid, minimum_short: minShort,
      interest, card_debt: cardDebt,
      credit_limit: totalLimit, utilization, cards_without_limit: cards.length - limited.length,
      interest_ytd: round2(cards.reduce((s, c) => s + c.interest_ytd, 0)),
      left_over: round2(Math.max(0, lowest - buffer)),
      lowest_balance: lowest,
      lowest_date: fromDayNum(dayNum(today) + lowDay),
      below_buffer: belowBuffer,
      missed_minimums: missedMinimums.length,
    },
    cards, timeline, suggestions,
    invest_threshold: INVEST_THRESHOLD(),
    status: (await store.listItems())
      .filter((i) => accounts.some((a) => a.item_id === i.item_id && a.type === 'credit') && !accounts.some((a) => a.item_id === i.item_id && a.manual))
      .map((i) => ({ institution: i.institution_name, status: statusOf(i, 'liabilities') })),
  };
}

app.get('/api/card-plan', async (req, res) => {
  const b = Number(req.query.buffer);
  res.json(await cardPlan({ buffer: Number.isFinite(b) && b >= 0 && b <= 1e6 ? b : PLAN_BUFFER() }));
});

// Your own details for a card: APR, a 0% promo, or the statement for a manual card.
const CARD_FIELDS = { credit_limit: 'money', apr: 'pct', promo_apr: 'pct', promo_end: 'date', statement_balance: 'money', statement_date: 'date', due_date: 'date', minimum_payment: 'money' };
app.put('/api/cards/:id', async (req, res) => {
  const accounts = await store.listAccounts();
  const a = accounts.find((x) => x.account_id === req.params.id);
  if (!a || a.type !== 'credit') return res.status(404).json({ error_message: 'Unknown credit card' });
  const out = {};
  for (const [k, kind] of Object.entries(CARD_FIELDS)) {
    const v = req.body?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return res.status(400).json({ error_message: `${k} must be a date (YYYY-MM-DD)` });
      out[k] = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (kind === 'pct' && n > 100) || n > 1e7) return res.status(400).json({ error_message: `${k} must be a number${kind === 'pct' ? ' from 0 to 100' : ''}` });
      out[k] = round2(n);
    }
  }
  if (out.statement_balance != null && !out.statement_date) return res.status(400).json({ error_message: 'Add the statement date with the statement balance' });
  await store.setCardSettings(req.params.id, Object.keys(out).length ? out : null);
  res.json({ ok: true, details: out });
});

// ----------------------------------------------------------------- loans --
// Mortgages and student loans from Plaid Liabilities (Plaid doesn't cover car
// or personal loans), your own details for anything it leaves out, and the
// payments seen arriving on the loan account. The browser builds the
// amortization schedule and the what-ifs from this.
const monthsBetween = (from, to) => {
  const [y1, m1] = from.split('-').map(Number), [y2, m2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};
const pmt = (balance, ratePct, months) => {
  if (!(balance > 0) || !(months > 0)) return null;
  const r = ratePct / 1200;
  return r ? (balance * r) / (1 - (1 + r) ** -months) : balance / months;
};

const kindOf = (a, p) => p.kind || (/mortgage|home/i.test(`${a.subtype} ${a.name}`) ? 'mortgage' : a.subtype || 'loan');

async function loanList() {
  const today = isoDate(new Date());
  const [accounts, statements, settings, txns, itemList] = await Promise.all([
    listAccounts(), store.listCardStatements(), store.listCardSettings(), categorizedTransactions(), store.listItems(),
  ]);
  const st = new Map(statements.filter((x) => x.kind === 'mortgage' || x.kind === 'student').map((x) => [x.account_id, x]));
  const us = new Map(settings.map((x) => [x.account_id, x]));
  const loans = accounts.filter((a) => a.type === 'loan').map((a) => {
    const p = st.get(a.account_id) || {};
    const u = us.get(a.account_id) || {};
    const pick = (mine, bank) => (mine != null ? { value: mine, source: 'you' } : bank != null ? { value: bank, source: 'bank' } : { value: null, source: null });
    // Payments that reached the loan account (the other half of the payment from checking).
    const paid = txns.filter((t) => t.account_id === a.account_id && t.amount < 0 && !t.pending).sort((x, y) => y.date.localeCompare(x.date));
    const observed = paid.length ? round2(median(paid.slice(0, 3).map((t) => -t.amount))) : null;
    const balance = Math.max(0, a.current_balance || 0);
    const rate = pick(u.rate, p.rate);
    const maturity = pick(u.maturity_date, p.maturity_date);
    const nextDue = pick(u.next_due_date, p.next_due_date);
    // Principal & interest: yours, or worked out from the balance, rate and payoff date.
    const start = nextDue.value && nextDue.value > today ? nextDue.value : today;
    const left = maturity.value ? Math.max(1, monthsBetween(start, maturity.value) + 1) : null;
    const computed = rate.value != null && left ? round2(pmt(balance, rate.value, left)) : null;
    const total = p.next_payment ?? observed; // what you actually pay each month
    // Without escrow (anything but a mortgage) what you actually pay is the P&I,
    // and it beats a calculation, which can't know you already pay a little extra.
    let pi = u.payment != null ? { value: u.payment, source: 'you' }
      : p.kind !== 'mortgage' && kindOf(a, p) !== 'mortgage' && total != null ? { value: total, source: p.next_payment != null ? 'bank' : 'payments' }
      : computed != null ? { value: computed, source: 'calculated' }
      : { value: null, source: null };
    const escrow = u.escrow != null ? { value: u.escrow, source: 'you' }
      : p.kind === 'mortgage' && total != null && pi.value != null && total - pi.value > 1 ? { value: round2(total - pi.value), source: 'calculated' }
      : { value: null, source: null };
    const missing = [rate.value == null && 'interest rate', pi.value == null && 'monthly payment'].filter(Boolean);
    return {
      account_id: a.account_id, name: acctNameOf(a), institution: a.institution_name, manual: a.manual,
      kind: kindOf(a, p),
      from_bank: !!p.kind, balance,
      rate, payment: pi, escrow, maturity_date: maturity, next_due_date: nextDue,
      total_payment: total, total_payment_source: p.next_payment != null ? 'bank' : observed != null ? 'payments' : null,
      original_principal: pick(u.original_principal, p.original_principal),
      origination_date: pick(u.origination_date, p.origination_date),
      loan_type: p.loan_type ?? null, rate_type: p.rate_type ?? null, loan_term: p.loan_term ?? null,
      escrow_balance: p.escrow_balance ?? null, has_pmi: p.has_pmi ?? null, has_prepayment_penalty: p.has_prepayment_penalty ?? null,
      past_due: p.past_due ?? null, ytd_interest: p.ytd_interest ?? null, ytd_principal: p.ytd_principal ?? null,
      payments: paid.slice(0, 12).map((t) => ({ date: t.date, amount: round2(-t.amount) })),
      mine: u, missing,
    };
  });
  const status = itemList
    .filter((i) => accounts.some((a) => a.item_id === i.item_id && a.type === 'loan' && !a.manual))
    .map((i) => ({ institution: i.institution_name, status: statusOf(i, 'liabilities') }));
  return { today, loans, status };
}

app.get('/api/loans', async (_req, res) => {
  res.json(await loanList());
});

const LOAN_FIELDS = { rate: 'pct', payment: 'money', escrow: 'money', maturity_date: 'date', next_due_date: 'date', original_principal: 'money', origination_date: 'date' };
app.put('/api/loans/:id', async (req, res) => {
  const a = (await store.listAccounts()).find((x) => x.account_id === req.params.id);
  if (!a || a.type !== 'loan') return res.status(404).json({ error_message: 'Unknown loan' });
  const out = {};
  for (const [k, kind] of Object.entries(LOAN_FIELDS)) {
    const v = req.body?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return res.status(400).json({ error_message: `${k} must be a date (YYYY-MM-DD)` });
      out[k] = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (kind === 'pct' && n > 100) || n > 1e8) return res.status(400).json({ error_message: `${k} must be a number${kind === 'pct' ? ' from 0 to 100' : ''}` });
      out[k] = kind === 'pct' ? Math.round(n * 1000) / 1000 : round2(n);
    }
  }
  await store.setCardSettings(req.params.id, Object.keys(out).length ? out : null);
  res.json({ ok: true, details: out });
});

// ---------------------------------------------------------------- alerts --
// Computed from the data on each request, so there's nothing to keep in sync.
const pretty = (c) => (c === 'OTHER' ? 'Other' : c || UNCATEGORIZED);
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const LARGE_PURCHASE = () => Number(process.env.ALERT_LARGE_AMOUNT || 500);
const MAX_ALERTS = 12;
// Large payments that aren't purchases: bills show up under Upcoming bills instead.
const EXPECTED_PAYMENTS = new Set(['Bills & Utilities', 'Taxes', 'Financial']);
const acctNameOf = (a) => `${a.display_name}${a.mask ? ` ••${a.mask}` : ''}`;

app.get('/api/alerts', async (_req, res) => {
  const today = isoDate(new Date());
  const alerts = [];
  const add = (id, level, date, ...parts) => alerts.push({ id, level, date, parts: parts.map((p) => (typeof p === 'string' ? { t: p } : p)) });
  const b = (t) => ({ t, strong: true });

  // Broken bank connections.
  // Banks waiting for your OK to share more are one alert, not one each.
  const allItems = await store.listItems();
  const consent = allItems.filter((i) => i.error === CONSENT_NEEDED);
  if (consent.length) {
    const what = [...new Set(consent.map((i) => consentFor(i)))];
    const label = what.length === 1 ? what[0] : 'more details';
    add(`consent:${consent.map((i) => i.item_id).sort().join(',')}`, 'warning', today,
      b(consent.map((i) => i.institution_name).join(', ')), ` ${consent.length > 1 ? 'need' : 'needs'} your OK to share ${label}. Click “Share” next to ${consent.length > 1 ? 'each bank' : 'it'} in the accounts list.`);
  }
  // Connections whose permission runs out soon: reconnecting renews it.
  for (const item of allItems) {
    const days = expiresInDays(item);
    if (days == null || days > EXPIRY_WARN_DAYS()) continue;
    const when = new Date(item.consent_expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    add(`expiry:${item.item_id}:${isoDate(new Date(item.consent_expires_at))}`, days <= 7 ? 'critical' : 'warning', today, b(item.institution_name),
      days <= 0 ? '’s connection has expired, so it no longer updates. Click “reconnect” next to it in the accounts list.'
        : `’s connection expires in ${days} day${days === 1 ? '' : 's'} (${when}). Click “reconnect” next to it in the accounts list to renew it.`);
  }
  for (const item of allItems) {
    if (item.error === CONSENT_NEEDED) continue;
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

  // Bills due in the next 3 days.
  for (const bill of (await detectRecurring()).filter((x) => !x.overdue && x.next_date <= daysAgo(-3))) {
    add(`bill:${bill.id}:${bill.next_date}`, 'info', today, b(bill.name), ` (${bill.variable ? 'about ' : ''}${usd(bill.amount)}) is due around ${new Date(`${bill.next_date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}.`);
  }

  // Details only you can add: a loan's rate, a card's statement, APR or limit.
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
  const plan = await cardPlan({ buffer: PLAN_BUFFER() });
  for (const c of plan.cards.filter((x) => x.missing.length)) {
    add(`missing:${c.account_id}:${c.missing.join(',')}`, 'info', today, b(c.name), ` is missing its ${list(c.missing)}, so the card plan ${c.missing.includes('statement') ? 'can’t include it' : 'has to guess'}. `,
      { t: `Add ${c.missing.length > 1 ? 'them' : 'it'}`, action: 'edit-card', account_id: c.account_id });
  }
  for (const l of (await loanList()).loans.filter((x) => x.missing.length && x.balance > 0)) {
    add(`missing:${l.account_id}:${l.missing.join(',')}`, 'info', today, b(l.name), ` is missing its ${list(l.missing)}, so there’s no payoff schedule yet. `,
      { t: `Add ${l.missing.length > 1 ? 'them' : 'it'}`, action: 'edit-loan', account_id: l.account_id });
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
    } else if (t.amount >= LARGE_PURCHASE() && !EXPECTED_PAYMENTS.has(t.parent)) {
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
