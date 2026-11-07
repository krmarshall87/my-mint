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
          if (cash === 20000) {
            assert.equal(d.totals.unpaid, 0);
            assert.equal(d.totals.interest, 0);
            for (const c of cards) assert.equal(c.pay, c.remaining);
          } else {
            assert.ok(d.totals.unpaid > 0);
            // Extra money goes to interest-bearing cards first: the 0% promo card only gets its minimum.
            const promo = cards.find((c) => c.account_id === 'disc');
            assert.ok(promo.promo);
            assert.ok(promo.pay <= promo.minimum + 0.01);
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

    await t.test('a car loan uses the payment from history and asks for the rate', async () => {
      assert.equal(car.payment.value, 450);
      assert.equal(car.payment.source, 'payments');
      assert.deepEqual(car.missing, ['interest rate']);
      assert.equal((await api.put('/api/loans/car', { rate: 170 })).status, 400);
      assert.equal((await api.put('/api/loans/car', { rate: 7.49, maturity_date: '2030-11-01' })).status, 200);
      const updated = (await api.get('/api/loans')).body.loans.find((l) => l.account_id === 'car');
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
}
