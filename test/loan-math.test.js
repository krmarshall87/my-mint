// Amortization checked against the owner's own spreadsheet
// ($149,004.97 at 3.99%, $793.46 principal & interest, from Feb 2025).
const test = require('node:test');
const assert = require('node:assert/strict');
const { amortize, ymAdd } = require('../public/loan-math.js');

const loan = { balance: 149004.97, rate: 3.99, payment: 793.46, start: '2025-02' };
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);

test('schedule rows match the spreadsheet to the cent', () => {
  const { rows } = amortize(loan);
  assert.deepEqual([rows[0].month, rows[0].principal, rows[0].interest], ['2025-02', 298.02, 495.44]);
  assert.deepEqual([rows[1].principal, rows[1].interest, rows[1].start], [299.01, 494.45, 148706.95]);
  assert.deepEqual([rows[15].month, rows[15].start, rows[15].principal, rows[15].interest], ['2026-05', 144429.13, 313.23, 480.23]);
  assert.equal(rows[15].principal_to_date, 4889.07);
  assert.equal(rows[15].interest_to_date, 7806.29);
});

test('total interest with no changes matches the spreadsheet', () => {
  const base = amortize(loan);
  near(base.interest, 85065.69, 0.1, 'total interest');
  assert.equal(base.never, false);
  assert.equal(base.rows.at(-1).balance, 0);
});

test('a one-time payment with recast keeps the payoff date and matches the spreadsheet', () => {
  const base = amortize(loan);
  const ten = amortize({ ...loan, lumps: [{ month: '2025-02', amount: 10000 }], recast: true });
  const twenty = amortize({ ...loan, lumps: [{ month: '2025-02', amount: 20000 }], recast: true });
  near(ten.interest, 79378.65, 2, '$10k recast');
  near(twenty.interest, 73691.61, 2, '$20k recast');
  assert.equal(ten.payoff, base.payoff);
  assert.equal(twenty.payoff, base.payoff);
  assert.ok(ten.payment < loan.payment && twenty.payment < ten.payment);
});

test('a one-time payment that shortens the loan saves more interest than a recast', () => {
  const lumps = [{ month: '2025-02', amount: 10000 }];
  const shorten = amortize({ ...loan, lumps });
  const recast = amortize({ ...loan, lumps, recast: true });
  assert.ok(shorten.interest < recast.interest);
  assert.ok(shorten.months < amortize(loan).months);
});

test('extra principal: more each month always saves more, with diminishing months per step', () => {
  const base = amortize(loan);
  let prev = { interest: base.interest, months: base.months, step: Infinity };
  for (const extra of [200, 250, 300, 350, 400]) {
    const w = amortize({ ...loan, extra });
    assert.ok(w.interest < prev.interest, `+$${extra} saves more than the step before`);
    assert.ok(w.months < prev.months);
    prev = { interest: w.interest, months: w.months };
  }
  // Standard amortization: +$200/month from Feb 2025 cuts 86 months.
  assert.equal(base.months - amortize({ ...loan, extra: 200 }).months, 86);
});

test('extra payments start in the chosen month', () => {
  const w = amortize({ ...loan, extra: 100, extraFrom: '2025-06' });
  assert.equal(w.rows[3].extra, 0);
  assert.equal(w.rows[4].month, '2025-06');
  assert.equal(w.rows[4].extra, 100);
});

test('a payment below the interest never pays off', () => {
  assert.equal(amortize({ balance: 100000, rate: 6, payment: 400, start: '2026-01' }).never, true);
});

test('ymAdd crosses year boundaries', () => {
  assert.equal(ymAdd('2025-12', 1), '2026-01');
  assert.equal(ymAdd('2025-01', -1), '2024-12');
  assert.equal(ymAdd('2025-02', 24), '2027-02');
});
