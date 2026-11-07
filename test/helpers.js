// Starts the real server with Plaid stubbed (test/fixtures/plaid-stub.js) and
// a throwaway store, and gives tests a small authenticated client.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'test-password';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

// Postgres runs only against a local database named in TEST_DATABASE_URL, and
// its tables are dropped first, so never point it at real data.
async function resetPostgres(url) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('TEST_DATABASE_URL must be a local database');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  for (const r of rows) await c.query(`DROP TABLE IF EXISTS "${r.tablename}" CASCADE`);
  await c.end();
}

async function startServer(env = {}, { store = 'file' } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-mint-test-'));
  const storeEnv = store === 'postgres'
    ? { DATABASE_URL: process.env.TEST_DATABASE_URL }
    : { DATA_FILE: path.join(dir, 'store.json'), DATABASE_URL: '' };
  if (store === 'postgres') await resetPostgres(process.env.TEST_DATABASE_URL);
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'plaid-stub.js'), 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, ...storeEnv,
      PORT: String(port), APP_PASSWORD: PASSWORD, PLAID_ENV: 'sandbox', PLAID_CLIENT_ID: 'test', PLAID_SECRET: 'test',
      ENCRYPTION_KEY: '0'.repeat(64), SYNC_INTERVAL_HOURS: '0', NODE_ENV: 'test', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(`me:${PASSWORD}`).toString('base64')}`;
  const request = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const api = {
    base, auth, request,
    get: (url) => request('GET', url),
    post: (url, body = {}) => request('POST', url, body),
    put: (url, body = {}) => request('PUT', url, body),
    del: (url) => request('DELETE', url),
    logs: () => logs,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
  // Wait until the schema is ready (the API answers 503 until then).
  for (let i = 0; i < 100; i++) {
    try { if ((await api.get('/api/items')).status === 200) return api; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await api.stop();
  throw new Error(`server did not start:\n${logs}`);
}

// Link the stubbed bank, the way the UI does after Plaid Link.
const linkBank = (api, name = 'Platypus Bank', token = 'p') =>
  api.post('/api/exchange', { public_token: token, institution: { institution_id: 'ins_test', name } });

module.exports = { startServer, linkBank, PASSWORD };
