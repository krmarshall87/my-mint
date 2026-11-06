const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { createStore } = require('./db');

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
      try {
        results.push({ item_id: item.item_id, ...(await syncItem(item)) });
      } catch (err) {
        results.push({ item_id: item.item_id, error: plaidError(err) });
      }
    }
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
  res.json((await store.listItems()).map(({ access_token, cursor, ...rest }) => rest));
});

app.delete('/api/items/:id', async (req, res) => {
  const item = await items.get(req.params.id);
  if (!item) return res.status(404).json({ error_message: 'Unknown item' });
  try {
    await plaid.itemRemove({ access_token: item.access_token });
  } catch (err) {
    console.error('item remove', plaidError(err));
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
const listAccounts = async () => (await store.listAccounts()).map((a) => ({ ...a, display_name: displayName(a) }));

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

// ------------------------------------------------------------ categories --
// Plaid's category is the starting point. On top of it, in priority order:
// your fix for one transaction, your merchant rules, and, only when Plaid says
// OTHER or nothing, what this merchant usually is in your own history, then a
// few built-in defaults for common merchants.
const isUncategorized = (c) => !c || c === 'OTHER';
const merchantText = (t) => `${t.merchant_name || ''} ${t.name || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
const merchantKey = (t) =>
  (t.merchant_name || t.name || '').toLowerCase().split('*')[0].replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const DEFAULT_CATEGORIES = [
  [/\b(doordash|grubhub|uber ?eats|instacart)\b/, 'FOOD_AND_DRINK'],
  [/\b(amazon|amzn|ebay|walmart|target|costco|best ?buy|etsy)\b/, 'GENERAL_MERCHANDISE'],
  [/\b(massage|spa|salon|barber|nails?)\b/, 'PERSONAL_CARE'],
  [/\b(uber|lyft)\b/, 'TRANSPORTATION'],
  [/\b(netflix|spotify|hulu|disney\+?|hbo|youtube premium)\b/, 'ENTERTAINMENT'],
];

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
    store.listRules(),
    store.listOverrides(),
  ]);
  const override = new Map(overrides.map((o) => [o.transaction_id, o.category]));
  const byLength = [...rules].sort((a, b) => b.pattern.length - a.pattern.length); // most specific rule wins

  // What each merchant usually is, from transactions Plaid did categorize.
  const counts = new Map();
  for (const t of transactions) {
    const key = merchantKey(t);
    if (!key || isUncategorized(t.category)) continue;
    const m = counts.get(key) || new Map();
    m.set(t.category, (m.get(t.category) || 0) + 1);
    counts.set(key, m);
  }
  const usual = new Map([...counts].map(([key, m]) => [key, [...m].sort((a, b) => b[1] - a[1])[0][0]]));

  const rows = transactions.map((t) => {
    const text = merchantText(t);
    let category = t.category;
    let source = 'plaid';
    const rule = byLength.find((r) => text.includes(r.pattern));
    if (override.has(t.transaction_id)) { category = override.get(t.transaction_id); source = 'manual'; }
    else if (rule) { category = rule.category; source = 'rule'; }
    else if (isUncategorized(category)) {
      const guess = usual.get(merchantKey(t)) || DEFAULT_CATEGORIES.find(([re]) => re.test(text))?.[1];
      if (guess) { category = guess; source = 'inferred'; }
    }
    return {
      ...t,
      plaid_category: t.category,
      category: category || 'OTHER',
      // Plaid's detail only describes Plaid's own category.
      category_detailed: source === 'plaid' ? t.category_detailed : null,
      category_source: source,
      rule: source === 'rule' ? rule.pattern : null,
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

const matchesFilters = (t, f) =>
  (!f.accountId || t.account_id === f.accountId) &&
  (!f.start || t.date >= f.start) &&
  (!f.end || t.date <= f.end) &&
  (!f.category || t.category === f.category) &&
  (!f.q || merchantText(t).includes(f.q));

// Newest first, with your categories applied, filtered in JS: identical for both stores.
const allTransactions = async (filters = {}) => (await categorizedTransactions()).filter((t) => matchesFilters(t, filters));

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

const normalizePattern = (p) => (typeof p === 'string' ? p.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) : '');

// Recategorize one transaction, or (with `pattern`) every transaction whose
// merchant text contains it, past and future. `category: null` resets one
// transaction to automatic.
app.put('/api/transactions/:id/category', async (req, res) => {
  const { category = null } = req.body || {};
  const pattern = normalizePattern(req.body?.pattern);
  if (category !== null && !isCategory(category)) return res.status(400).json({ error_message: 'Invalid category' });
  const t = (await categorizedTransactions()).find((x) => x.transaction_id === req.params.id);
  if (!t) return res.status(404).json({ error_message: 'Unknown transaction' });
  if (pattern) {
    if (category === null) return res.status(400).json({ error_message: 'Choose a category for the rule' });
    if (pattern.length < 2) return res.status(400).json({ error_message: 'Make the matching text at least 2 characters' });
    await store.setRule(pattern, category);
    // The rule covers this transaction too, unless its text doesn't match.
    await store.setOverride(t.transaction_id, merchantText(t).includes(pattern) ? null : category);
  } else {
    await store.setOverride(t.transaction_id, category);
  }
  bumpData();
  res.json({ ok: true });
});

app.get('/api/rules', async (_req, res) => {
  const [rules, rows] = await Promise.all([store.listRules(), categorizedTransactions()]);
  res.json(rules.map((r) => ({ ...r, matches: rows.filter((t) => t.rule === r.pattern).length })));
});

app.delete('/api/rules', async (req, res) => {
  const pattern = normalizePattern(req.query.pattern);
  if (!pattern) return res.status(400).json({ error_message: 'Missing pattern' });
  await store.deleteRule(pattern);
  bumpData();
  res.json({ ok: true });
});

// ------------------------------------------------------------- insights --
// Money moving between your own accounts isn't income or spending: counting it
// would double-count (a card payment, then the card purchases it pays for).
const isInternalMove = (t) =>
  t.category === 'TRANSFER_IN' ||
  t.category === 'TRANSFER_OUT' ||
  t.category_detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';

const round2 = (n) => Math.round(n * 100) / 100;
const merchantOf = (t) => t.merchant_name || t.name || 'Unknown';
const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDate(new Date(Date.now() - n * 86400000));

// Income is money in that Plaid categorizes as INCOME. Any other money in is a
// refund and reduces spending in its own category.
function aggregate(transactions, { includeInternal = false } = {}) {
  const out = { income: 0, spending: 0, categories: new Map(), months: new Map(), merchants: new Map(), counted: 0 };
  for (const t of transactions) {
    if (!includeInternal && isInternalMove(t)) continue;
    out.counted += 1;
    const month = t.date.slice(0, 7);
    const m = out.months.get(month) || { month, income: 0, spending: 0 };
    if (t.category === 'INCOME') {
      out.income -= t.amount;
      m.income -= t.amount;
    } else {
      out.spending += t.amount;
      m.spending += t.amount;
      const cat = t.category || 'UNCATEGORIZED';
      out.categories.set(cat, (out.categories.get(cat) || 0) + t.amount);
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
// biggest spending categories of all time own slots 1-7 and everything else is
// "Other", so changing a filter never repaints a category.
const COLOR_SLOTS = 7;
function categorySlots(allTime) {
  const ranked = [...aggregate(allTime).categories].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return new Map(ranked.slice(0, COLOR_SLOTS).map(([cat], i) => [cat, i + 1]));
}

// Aggregates for the charts, scoped by the same filters as the transaction list.
// Done in JS so it's identical for every store; a single user's history is small.
app.get('/api/insights', async (req, res) => {
  const filters = parseFilters(req.query);
  const [txns, allTime] = await Promise.all([allTransactions(filters), allTransactions()]);
  // An explicit category filter (e.g. Transfer out) shows what was asked for instead of hiding it.
  const agg = aggregate(txns, { includeInternal: !!filters.category });
  const slots = categorySlots(allTime);

  const categories = [];
  let other = 0, otherCount = 0;
  for (const [category, amount] of agg.categories) {
    if (amount <= 0) continue;
    if (slots.has(category)) categories.push({ category, amount: round2(amount), slot: slots.get(category) });
    else { other += amount; otherCount += 1; }
  }
  categories.sort((a, b) => b.amount - a.amount);
  if (other > 0) categories.push({ category: 'OTHER', amount: round2(other), slot: 0, categories: otherCount });

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
// A budget is a monthly limit per Plaid category; INCOME is the expected income.
const isCategory = (c) => typeof c === 'string' && /^[A-Z_]{2,64}$/.test(c);

app.get('/api/budgets', async (_req, res) => res.json(await store.listBudgets()));

app.put('/api/budgets/:category', async (req, res) => {
  const { category } = req.params;
  const amount = Number(req.body?.amount);
  if (!isCategory(category)) return res.status(400).json({ error_message: 'Invalid category' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return res.status(400).json({ error_message: 'Amount must be a positive number' });
  await store.setBudget(category, round2(amount));
  res.json({ category, amount: round2(amount) });
});

app.delete('/api/budgets/:category', async (req, res) => {
  if (!isCategory(req.params.category)) return res.status(400).json({ error_message: 'Invalid category' });
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
  const spending = budgets
    .filter((b) => b.category !== 'INCOME')
    .map((b) => ({ category: b.category, budget: b.amount, spent: round2(Math.max(0, agg.categories.get(b.category) || 0)) }))
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget);
  const unbudgeted = [...agg.categories].filter(([c]) => !budgetOf.has(c)).reduce((s, [, v]) => s + v, 0);
  const budgetedSpending = spending.reduce((s, b) => s + b.budget, 0);
  return {
    month,
    progress,
    income: { actual: round2(agg.income), budget: budgetOf.get('INCOME') ?? null },
    spending,
    unbudgeted: round2(Math.max(0, unbudgeted)),
    totals: {
      income: round2(agg.income),
      spending: round2(agg.spending),
      budgetedIncome: budgetOf.get('INCOME') ?? null,
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

// ---------------------------------------------------------------- alerts --
// Computed from the data on each request, so there's nothing to keep in sync.
const pretty = (c) => (c ? c.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()) : 'Uncategorized');
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const LARGE_PURCHASE = () => Number(process.env.ALERT_LARGE_AMOUNT || 500);
const MAX_ALERTS = 12;

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

  // Large purchases and income in the last week.
  const accounts = new Map((await listAccounts()).map((a) => [a.account_id, a]));
  const acctName = (id) => {
    const a = accounts.get(id);
    return a ? `${a.display_name}${a.mask ? ` ••${a.mask}` : ''}` : 'your account';
  };
  for (const t of await allTransactions({ start: daysAgo(6), end: today })) {
    if (isInternalMove(t)) continue;
    if (t.category === 'INCOME' && t.amount < 0) {
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

async function initDatabase() {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.init();
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
