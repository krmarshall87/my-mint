// End-to-end: the real server with Plaid stubbed. Runs on the JSON store, and
// on Postgres too when TEST_DATABASE_URL points at a local database.
// Dates in the stub are relative to today, so these check rules that hold on
// any day rather than exact dollar amounts that depend on the calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, linkBank } = require('./helpers');

const stores = ['file', ...(process.env.TEST_DATABASE_URL ? ['postgres'] : [])];

for (const store of stores) {
  test(`[${store}] sync, categories and protections`, async (t) => {
    const api = await startServer({}, { store });
    t.after(() => api.stop());
    const linked = await linkBank(api);
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.body.sync.cards.statements, 3);
    assert.equal(linked.body.sync.cards.loans, 1);

    await t.test('every account is saved, including loans and investments', async () => {
      const accounts = (await api.get('/api/accounts')).body;
      const types = new Set(accounts.map((a) => a.type));
      for (const type of ['depository', 'credit', 'loan', 'investment']) assert.ok(types.has(type), type);
      assert.ok(accounts.every((a) => a.display_name), 'display names');
      assert.ok(!JSON.stringify(accounts).includes('access-sandbox'), 'no access tokens in the API');
    });

    await t.test('re-syncing never duplicates transactions', async () => {
      const before = (await api.get('/api/transactions?limit=1000')).body.total;
      assert.equal((await api.post('/api/sync')).status, 200);
      assert.equal((await api.get('/api/transactions?limit=1000')).body.total, before);
    });

    await t.test('categories follow the Mint tree, and loan activity is excluded', async () => {
      const txns = (await api.get('/api/transactions?limit=1000')).body.transactions;
      const byName = (n) => txns.find((x) => x.name === n);
      assert.equal(byName('ACME CORP PAYROLL').category, 'Paycheck');
      assert.equal(byName('US BANK HOME MTG').category, 'Mortgage & Rent');
      assert.equal(byName('INTEREST CHARGE ON PURCHASES').category, 'Finance Charge');
      assert.equal(byName('PAYMENT RECEIVED').excluded, true, 'payment arriving on the mortgage account');
    });

    await t.test('bills and paychecks are detected from history', async () => {
      const bills = (await api.get('/api/recurring')).body.bills;
      const mortgage = bills.find((b) => /home mtg/i.test(b.name));
      assert.ok(mortgage, 'mortgage found');
      assert.equal(mortgage.frequency, 'monthly');
      const plan = (await api.get('/api/card-plan')).body;
      assert.deepEqual(plan.income.map((p) => p.name).sort(), ['ACME CORP PAYROLL', 'INITECH PAYROLL']);
    });

    await t.test('requires the password, and blocks cross-site writes', async () => {
      assert.equal((await fetch(`${api.base}/api/items`)).status, 401);
      assert.equal((await fetch(`${api.base}/healthz`)).status, 200);
      for (const icon of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']) {
        assert.equal((await fetch(api.base + icon)).status, 200, `${icon} is public`);
      }
      assert.equal((await fetch(`${api.base}/app.js`)).status, 401, 'everything else needs the password');
      const cross = await api.request('POST', '/api/sync', {}, { origin: 'https://evil.example' });
      assert.equal(cross.status, 403);
      const crossSite = await api.request('POST', '/api/sync', {}, { 'sec-fetch-site': 'cross-site' });
      assert.equal(crossSite.status, 403);
      const sameOrigin = await api.request('POST', '/api/sync', {}, { origin: api.base, 'sec-fetch-site': 'same-origin' });
      assert.equal(sameOrigin.status, 200);
    });

    await t.test('renaming an account shows up in bills right away', async () => {
      const before = (await api.get('/api/recurring')).body.bills.find((b) => /home mtg/i.test(b.name));
      assert.ok(before.account);
      assert.equal((await api.request('PATCH', '/api/accounts/chk', { nickname: 'Joint Checking' })).status, 200);
      const after = (await api.get('/api/recurring')).body.bills.find((b) => /home mtg/i.test(b.name));
      assert.match(after.account, /^Joint Checking/);
    });

    await t.test('the raw Plaid response is available, with account numbers masked', async () => {
      const id = (await api.get('/api/items')).body[0].item_id;
      const raw = (await api.get(`/api/plaid-raw/${id}/liabilities`)).body;
      assert.equal(raw.product, 'liabilities');
      assert.equal(raw.response.liabilities.credit.length, 3);
      assert.equal(raw.response.liabilities.mortgage[0].account_number, '••4012');
      assert.ok(!JSON.stringify(raw).includes('3120194012'));
      assert.ok(!JSON.stringify(raw).includes('access-sandbox'), 'no access token');
      const accounts = (await api.get(`/api/plaid-raw/${id}/accounts`)).body;
      assert.equal(accounts.response.accounts.find((a) => a.account_id === 'disc').balances.limit, undefined, 'Discover sends no limit');
      const raw2 = (await api.get(`/api/plaid-raw/${id}/item`)).body;
      assert.ok(raw2.response.item.consented_products.includes('liabilities'));
      const inst = (await api.get(`/api/plaid-raw/${id}/institution`)).body;
      assert.ok(inst.response.institution.products.includes('liabilities'));
      assert.equal((await api.get(`/api/plaid-raw/${id}/transactions`)).status, 400);
      assert.equal((await api.get('/api/plaid-raw/nope/accounts')).status, 404);
      assert.equal((await fetch(`${api.base}/api/plaid-raw/${id}/accounts`)).status, 401);
    });

    await t.test('removing a bank removes its data', async () => {
      const id = (await api.get('/api/items')).body[0].item_id;
      await api.put('/api/cards/disc', { credit_limit: 3000 });
      assert.equal((await api.del(`/api/items/${id}`)).status, 200);
      assert.equal((await api.get('/api/accounts')).body.length, 0);
      assert.equal((await api.get('/api/card-plan')).body.cards.length, 0);
      assert.equal((await api.get('/api/loans')).body.loans.length, 0);
    });
  });

  test(`[${store}] credit card plan`, async (t) => {
    for (const [cash, label] of [[20000, 'plenty of cash'], [3200, 'tight'], [200, 'short']]) {
      await t.test(label, async () => {
        const api = await startServer({ STUB_CASH: String(cash) }, { store });
        try {
          await linkBank(api);
          const d = (await api.get('/api/card-plan?buffer=500')).body;
          const cards = d.cards.filter((c) => !c.needs_details);
          assert.equal(cards.length, 3);
          // Still owed = statement − payments since it (Citi: $3,500 − $500).
          assert.equal(d.cards.find((c) => c.account_id === 'citi').remaining, 3000);
          // A card payment never takes checking below the buffer.
          for (const e of d.timeline.filter((x) => x.type === 'card')) assert.ok(e.balance >= d.buffer - 0.01 || d.totals.below_buffer > 0, `${e.name} on ${e.date}`);
          // Nothing is paid beyond what's owed.
          for (const c of cards) assert.ok(c.pay + c.pay_late <= c.remaining + 0.01, c.name);
          // "Money's there now" never counts the same dollars twice: together,
          // those payments fit in checking today, above the buffer.
          const now = cards.filter((c) => c.funded_by === 'checking');
          assert.ok(now.reduce((s, c) => s + c.pay, 0) <= d.checking.total - d.buffer + 0.01 || d.totals.below_buffer > 0, 'pay-now cards fit in checking');
          assert.equal(Math.round((d.totals.pay_now + d.totals.pay_after_paycheck) * 100), Math.round(cards.filter((c) => c.funded_by).reduce((s, c) => s + c.pay, 0) * 100));
          // The summary looks only as far as the plan does.
          assert.ok(d.totals.income_plan <= d.totals.income && d.totals.bills_plan <= d.totals.bills);
          if (cash === 20000) {
            assert.equal(d.totals.unpaid, 0);
            assert.equal(d.totals.interest, 0);
            for (const c of cards) assert.equal(c.pay, c.remaining);
          } else {
            assert.ok(d.totals.unpaid > 0);
            // Extra money goes to interest-bearing cards first: the 0% promo card only gets its minimum.
            const promo = cards.find((c) => c.account_id === 'disc');
            assert.ok(promo.promo);
            // More than its minimum only once every interest-charging balance is covered.
            const interestLeft = cards.filter((c) => !c.promo).some((c) => c.remaining - (c.promo_balance || 0) - c.pay - c.pay_late > 0.01);
            if (interestLeft) assert.ok(promo.pay <= promo.minimum + 0.01, 'promo card only gets its minimum');
            assert.ok(d.suggestions.some((s) => s.type === 'savings'), 'suggests savings');
            assert.ok(!d.suggestions.some((s) => s.type === 'investments'), 'card debt is under the investment threshold');
          }
          if (cash === 200) assert.ok(d.totals.below_buffer > 0, 'bills alone overdraw checking');
          // Utilization: Citi owes $4,000 of a $10,000 limit.
          const citi = d.cards.find((c) => c.account_id === 'citi');
          assert.equal(citi.utilization, 40);
          assert.equal(citi.interest_charged, 61.2);
        } finally {
          await api.stop();
        }
      });
    }
  });

  test(`[${store}] card plan accuracy`, async (t) => {
    const api = await startServer({ STUB_CASH: '3200' }, { store });
    t.after(() => api.stop());
    await linkBank(api);
    const card = async (id) => (await api.get('/api/card-plan')).body.cards.find((c) => c.account_id === id);

    await t.test('interest uses the bank\'s rate per balance, and a 0% part needn\'t be paid', async () => {
      const citi = await card('citi');
      assert.deepEqual(citi.rate_buckets.map((b) => [b.apr, b.balance]), [[0, 1000], [29.99, 2500]]);
      assert.equal(citi.promo_balance, 1000);
      assert.equal(citi.promo, null, 'not a promo card: most of it is at 29.99%');
      assert.equal(citi.apr, 29.99);
      // Unpaid money sits at the lowest rate first: $1,000 of it is free.
      assert.equal(citi.interest_if_unpaid, Math.round(((3000 - 1000) * 29.99 / 1200) * 100) / 100);
    });

    await t.test('a payment that left checking counts before it reaches the card, if it\'s clearly for that card', async () => {
      const chase = await card('chase');
      // $40 = Chase's minimum: counted.
      assert.deepEqual(chase.in_transit.map((p) => [p.amount, p.pending]), [[40, true]]);
      assert.equal(chase.paid_since_statement, 40);
      assert.equal(chase.remaining, 1760);
      // $800 matches nothing Chase asked for: shown, not counted.
      assert.deepEqual(chase.possible_transit.map((p) => p.amount), [800]);
      // The $500 transfer to Chase savings isn't a card payment at all.
      assert.ok(![...chase.in_transit, ...chase.possible_transit].some((p) => p.amount === 500));
    });

    await t.test('the bank\'s past-due flag raises an alert until the minimum is paid', async () => {
      // Chase's $40 minimum is on the way, so it's no longer past due.
      assert.equal((await card('chase')).bank_overdue, false);
      assert.ok(!(await api.get('/api/alerts')).body.some((a) => a.id.startsWith('overdue:chase')));
      // Discover is past due with its $35 minimum unpaid: critical alert.
      assert.equal((await card('disc')).bank_overdue, true);
      const alert = (await api.get('/api/alerts')).body.find((a) => a.id.startsWith('overdue:disc'));
      assert.equal(alert.level, 'critical');
    });

    await t.test('a statement cycle works out a statement the bank doesn\'t share', async () => {
      let onep = await card('onep');
      assert.equal(onep.needs_details, true);
      assert.deepEqual(onep.missing, ['statement', 'APR']);
      assert.equal((await api.put('/api/cards/onep', { closing_day: 5 })).status, 400, 'needs both days');
      assert.equal((await api.put('/api/cards/onep', { closing_day: 40, due_day: 1 })).status, 400);
      // Close yesterday-ish is too fiddly for a date-independent test: close on the 1st, due on the 28th.
      assert.equal((await api.put('/api/cards/onep', { closing_day: 1, due_day: 28, min_floor: 40, min_pct: 1, apr: 28.99 })).status, 200);
      onep = await card('onep');
      assert.equal(onep.source, 'cycle');
      assert.equal(onep.needs_details, false);
      assert.deepEqual(onep.missing, []);
      assert.equal(onep.statement_date.slice(8), '01');
      assert.equal(onep.due_date.slice(8), '28');
      assert.ok(onep.due_date > onep.statement_date);
      // Balance on the closing day = today's balance minus what posted since.
      const since = (await api.get('/api/transactions?account_id=onep&limit=100')).body.transactions
        .filter((x) => !x.pending && x.date > onep.statement_date).reduce((s, x) => s + x.amount, 0);
      assert.equal(onep.statement_balance, Math.round((1483.24 - since) * 100) / 100);
      // Minimum: the greater of $40 or 1% of it.
      assert.equal(onep.minimum_payment, Math.round(Math.max(40, onep.statement_balance * 0.01) * 100) / 100);
      assert.ok(!(await api.get('/api/alerts')).body.some((a) => a.id.startsWith('missing:onep:')));
    });
  });

  test(`[${store}] loans`, async (t) => {
    const api = await startServer({}, { store });
    t.after(() => api.stop());
    await linkBank(api);
    const loans = (await api.get('/api/loans')).body.loans;
    const mortgage = loans.find((l) => l.account_id === 'mtg');
    const car = loans.find((l) => l.account_id === 'car');

    await t.test('a mortgage splits its payment into P&I and escrow', () => {
      assert.equal(mortgage.kind, 'mortgage');
      assert.equal(mortgage.rate.value, 6.25);
      assert.equal(mortgage.payment.source, 'calculated');
      assert.equal(Math.round((mortgage.payment.value + mortgage.escrow.value) * 100) / 100, 1800);
      assert.equal(mortgage.ytd_interest, 13900);
    });

    await t.test('missing details are asked for in alerts', async () => {
      const alerts = (await api.get('/api/alerts')).body;
      const car = alerts.find((a) => a.id.startsWith('missing:car:'));
      assert.ok(car, 'car loan alert');
      assert.match(car.parts.map((p) => p.t).join(''), /missing its interest rate/);
      assert.deepEqual(car.parts.at(-1), { t: 'Add it', action: 'edit-loan', account_id: 'car' });
      // Discover has no limit from the bank.
      const disc = alerts.find((a) => a.id.startsWith('missing:disc:'));
      assert.ok(disc && disc.parts.at(-1).action === 'edit-card');
      assert.ok(!alerts.some((a) => a.id.startsWith('missing:mtg:')), 'the mortgage has everything');
    });

    await t.test('a car loan uses the payment from history and asks for the rate', async () => {
      assert.equal(car.payment.value, 450);
      assert.equal(car.payment.source, 'payments');
      assert.deepEqual(car.missing, ['interest rate']);
      assert.equal((await api.put('/api/loans/car', { rate: 170 })).status, 400);
      assert.equal((await api.put('/api/loans/car', { rate: 7.49, maturity_date: '2030-11-01' })).status, 200);
      const updated = (await api.get('/api/loans')).body.loans.find((l) => l.account_id === 'car');
      assert.ok(!(await api.get('/api/alerts')).body.some((a) => a.id.startsWith('missing:car:')), 'alert goes away once added');
      assert.equal(updated.rate.value, 7.49);
      assert.equal(updated.rate.source, 'you');
      assert.equal(updated.payment.value, 450, 'what you actually pay beats a calculation');
      assert.equal((await api.put('/api/loans/chk', { rate: 5 })).status, 404);
    });
  });

  test(`[${store}] permissions and connection expiry`, async (t) => {
    await t.test('a bank that needs consent gets one Share button and one alert', async () => {
      const api = await startServer({ STUB_MODE: 'consent' }, { store });
      try {
        await linkBank(api);
        const [item] = (await api.get('/api/items')).body;
        assert.equal(item.error, 'ADDITIONAL_CONSENT_REQUIRED');
        assert.equal(item.consent_for, 'card statements');
        const alerts = (await api.get('/api/alerts')).body.filter((a) => a.id.startsWith('consent:'));
        assert.equal(alerts.length, 1);
        await api.post('/api/link-token', { item_id: item.item_id });
        assert.match(api.logs(), /LINK \{"c":\["investments","liabilities"\],"u":\{"account_selection_enabled":true\}/);
        // Investments worked, so the Investments tab must not claim it needs consent.
        assert.equal((await api.get('/api/investments')).body.status[0].status, null);
      } finally {
        await api.stop();
      }
    });

    await t.test('a bank that can\'t share card statements stops asking for consent', async () => {
      const api = await startServer({ STUB_MODE: 'consent', STUB_INST_PRODUCTS: 'transactions,investments' }, { store });
      try {
        await linkBank(api);
        const [item] = (await api.get('/api/items')).body;
        assert.equal(item.error, null, 'no consent error to fix');
        assert.equal(item.consent_for, undefined);
        assert.ok(!(await api.get('/api/alerts')).body.some((a) => a.id.startsWith('consent:')));
        assert.equal((await api.get('/api/card-plan')).body.status[0].status, 'PRODUCTS_NOT_SUPPORTED');
      } finally {
        await api.stop();
      }
    });

    await t.test('a product that isn\'t enabled falls back without breaking Link', async () => {
      const api = await startServer({ STUB_MODE: 'noliab' }, { store });
      try {
        await linkBank(api);
        assert.equal((await api.post('/api/link-token', {})).status, 200);
        assert.match(api.logs(), /LINK \{"c":\["investments"\],"u":null,"p":\["transactions"\]\}/);
        const plan = (await api.get('/api/card-plan')).body;
        assert.equal(plan.status[0].status, 'INVALID_PRODUCT');
        assert.ok(plan.cards.every((c) => c.needs_details));
      } finally {
        await api.stop();
      }
    });

    await t.test('which permission a bank needs survives a restart', async () => {
      const first = await startServer({ STUB_MODE: 'consent' }, { store });
      await linkBank(first);
      await first.stop({ keep: true });
      // Restart on the same data. The server doesn't sync on startup, so nothing is re-learned.
      const api = await startServer({ STUB_MODE: 'consent' }, { store, dir: first.dir, keepDb: true });
      try {
        const [item] = (await api.get('/api/items')).body;
        assert.equal(item.consent_for, 'card statements');
        assert.equal((await api.get('/api/investments')).body.status[0].status, null);
        assert.equal((await api.get('/api/card-plan')).body.status[0].status, 'ADDITIONAL_CONSENT_REQUIRED');
      } finally {
        await api.stop();
      }
    });

    await t.test('an expiring connection raises an alert', async () => {
      const api = await startServer({ STUB_EXPIRY_DAYS: '5' }, { store });
      try {
        await linkBank(api);
        assert.equal((await api.get('/api/items')).body[0].expires_in_days, 5);
        const alert = (await api.get('/api/alerts')).body.find((a) => a.id.startsWith('expiry:'));
        assert.equal(alert.level, 'critical');
      } finally {
        await api.stop();
      }
    });
  });

  test(`[${store}] relinking, canceled activity, raw views, dates`, async (t) => {
    await t.test('linking the same bank again replaces the old connection and keeps your changes', async () => {
      const api = await startServer({}, { store });
      try {
        await linkBank(api);
        assert.equal((await api.request('PATCH', '/api/accounts/chk', { nickname: 'Joint checking' })).status, 200);
        assert.equal((await api.put('/api/cards/onep', { apr: 20.24 })).status, 200);
        const refund = (await api.get('/api/transactions?limit=500')).body.transactions.find((x) => x.name === 'AMAZON REFUND');
        assert.equal((await api.put(`/api/transactions/${refund.transaction_id}/category`, { category: 'Shopping' })).status, 200);

        const r = await linkBank(api, 'Platypus Bank', 'relink');
        assert.deepEqual(r.body.replaced, ['item-stub']);
        const accounts = (await api.get('/api/accounts')).body;
        assert.equal(accounts.filter((a) => a.mask === '0000').length, 1, 'no duplicate checking account');
        assert.ok(accounts.every((a) => a.item_id === 'relink'));
        assert.equal(accounts.find((a) => a.account_id === 'chk-2').display_name, 'Joint checking');
        const card = (await api.get('/api/card-plan')).body.cards.find((c) => c.account_id === 'onep-2');
        assert.equal(card.apr, 20.24);
        assert.equal(card.apr_mine, true);
        const moved = (await api.get('/api/transactions?limit=500')).body.transactions.find((x) => x.transaction_id === `${refund.transaction_id}-2`);
        assert.equal(moved.category, 'Shopping');
        assert.equal((await api.get('/api/items')).body.length, 1);
      } finally {
        await api.stop();
      }
    });

    await t.test('investment activity Plaid stops returning is removed', async () => {
      const api = await startServer({ STUB_INV_CANCEL: '1' }, { store });
      try {
        await linkBank(api);
        const has = async () => (await api.get('/api/transactions?limit=500')).body.transactions.some((x) => x.name === 'DIVIDEND VTI');
        assert.ok(await has(), 'dividend synced');
        await api.post('/api/sync');
        assert.ok(!(await has()), 'canceled dividend removed');
      } finally {
        await api.stop();
      }
    });

    await t.test('raw Plaid views refuse requests started by another site', async () => {
      const api = await startServer({}, { store });
      try {
        await linkBank(api);
        assert.equal((await api.request('GET', '/api/plaid-raw/item-stub/accounts', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
        assert.equal((await api.request('GET', '/api/plaid-raw/item-stub/accounts', undefined, { 'sec-fetch-site': 'same-site' })).status, 403);
        assert.equal((await api.request('GET', '/api/plaid-raw/item-stub/accounts', undefined, { 'sec-fetch-site': 'same-origin' })).status, 200);
      } finally {
        await api.stop();
      }
    });

    await t.test('"today" is the date in the app’s time zone, not UTC', async () => {
      // UTC+14: for 10 hours a day it's already tomorrow there.
      const api = await startServer({ TZ: 'Pacific/Kiritimati' }, { store });
      try {
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
        assert.equal((await api.get('/api/card-plan')).body.today, local);
      } finally {
        await api.stop();
      }
    });
  });
}
