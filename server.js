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
app.get('/healthz', (_req, res) => res.send('ok'));
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(password, APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="my-mint", charset="UTF-8"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'public')));

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
      const item = await store.getItem(itemId);
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
    await store.saveItem(item);
    let sync = null;
    try {
      sync = await syncItem(await store.getItem(item.item_id));
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
  const results = [];
  for (const item of await store.listItems()) {
    try {
      results.push({ item_id: item.item_id, ...(await syncItem(item)) });
    } catch (err) {
      results.push({ item_id: item.item_id, error: plaidError(err) });
    }
  }
  res.json({ results });
});

app.get('/api/items', async (_req, res) => {
  const items = await store.listItems();
  res.json(items.map(({ access_token, cursor, ...rest }) => rest));
});

app.delete('/api/items/:id', async (req, res) => {
  const item = await store.getItem(req.params.id);
  if (!item) return res.status(404).json({ error_message: 'Unknown item' });
  try {
    await plaid.itemRemove({ access_token: item.access_token });
  } catch (err) {
    console.error('item remove', plaidError(err));
  }
  await store.deleteItem(item.item_id);
  res.json({ ok: true });
});

app.get('/api/accounts', async (_req, res) => {
  res.json(await store.listAccounts());
});

app.get('/api/categories', async (_req, res) => {
  res.json(await store.listCategories());
});

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
app.get('/api/transactions', async (req, res) => {
  const q = req.query;
  const filters = {
    accountId: q.account_id || null,
    start: isDate(q.start) ? q.start : null,
    end: isDate(q.end) ? q.end : null,
    category: q.category || null,
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim() : null,
    limit: Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 5000),
    offset: Math.max(parseInt(q.offset, 10) || 0, 0),
  };
  res.json(await store.listTransactions(filters));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error_message: 'Internal error' });
});

store.init().then(() => {
  app.listen(PORT, () => console.log(`my-mint listening on :${PORT} (Plaid ${PLAID_ENV})`));
});
