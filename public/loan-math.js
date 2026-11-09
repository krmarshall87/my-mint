// Loan math shared by the page (app.js) and the tests. No DOM, no network.
(function (root) {
  const ymAdd = (ym, k) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
  const isYm = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v || '');
  const r2 = (n) => Math.round(n * 100) / 100;

  // Month-by-month schedule. Extra principal goes on from `extraFrom`; lumps are
  // one-time payments in a given month. A one-time payment normally shortens the
  // loan; with `recast` the lender re-amortizes instead, so the payoff date stays
  // and the monthly payment drops. Stops when paid off (or after 60 years).
  function amortize({ balance, rate, payment, start, extra = 0, extraFrom = start, lumps = [], recast = false }) {
    const r = rate / 1200;
    const lumpBy = new Map();
    for (const l of lumps) if (l.amount > 0 && isYm(l.month)) lumpBy.set(l.month, (lumpBy.get(l.month) || 0) + l.amount);
    const term = recast && lumpBy.size ? amortize({ balance, rate, payment, start }).months : null;
    const rows = [];
    let bal = balance, ym = start, interestTotal = 0, principalTotal = 0, pay = payment;
    for (let i = 0; bal > 0.005 && i < 720; i++) {
      const startBal = bal;
      const interest = r2(bal * r);
      const principal = Math.min(bal, pay - interest);
      const lump = lumpBy.get(ym) || 0;
      let ext = (ym >= extraFrom ? extra : 0) + lump;
      ext = Math.max(0, Math.min(ext, bal - principal));
      bal = r2(bal - principal - ext);
      interestTotal += interest;
      principalTotal += principal + ext;
      rows.push({ n: i + 1, month: ym, start: startBal, interest, principal: r2(principal), extra: r2(ext), payment: r2(interest + principal + ext),
        balance: Math.max(0, bal), principal_to_date: r2(principalTotal), interest_to_date: r2(interestTotal), regular: r2(pay) });
      // Recast: same payoff date, smaller payment from next month on.
      if (term && lump && bal > 0.005) {
        const left = term - (i + 1);
        // Rounded up to the cent, so rounding never adds a stray last month.
        pay = left > 0 ? Math.ceil((r ? (bal * r) / (1 - (1 + r) ** -left) : bal / left) * 100 - 1e-6) / 100 : pay;
      }
      ym = ymAdd(ym, 1);
    }
    return { rows, interest: r2(interestTotal), months: rows.length, payoff: rows.length ? rows[rows.length - 1].month : start, never: bal > 0.005, payment: pay };
  }

  const monthsBetween = (a, b) => {
    const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
  };
  const payment = (balance, rate, months) => {
    const r = rate / 1200;
    return r ? (balance * r) / (1 - (1 + r) ** -months) : balance / months;
  };
  // "30 year", "360 month", "15 years" → months.
  const termMonths = (term) => {
    const m = /(\d+(?:\.\d+)?)\s*(year|yr|month|mo)/i.exec(term || '');
    if (!m) return null;
    return Math.round(Number(m[1]) * (/^y/i.test(m[2]) ? 12 : 1));
  };

  // Where the loan stands against its original schedule: which payment is
  // next ("88 of 360") and how far ahead or behind the balance is. Needs the
  // original amount, the rate, and the term or both the start and payoff dates.
  function loanProgress({ originalPrincipal, rate, term, origination, maturity, nextDue, balance }) {
    if (!(originalPrincipal > 0) || rate == null || !nextDue) return null;
    let n = termMonths(term);
    // Without a term: the first payment usually comes the second month after closing.
    if (!n && origination && maturity) n = monthsBetween(origination.slice(0, 7), maturity.slice(0, 7)) - 1;
    if (!n) return null;
    // First payment: n−1 months before the last one, or (without a payoff date)
    // the second month after closing, the same assumption as above.
    const first = maturity ? ymAdd(maturity.slice(0, 7), -(n - 1)) : origination ? ymAdd(origination.slice(0, 7), 2) : null;
    if (!first) return null;
    const paymentNumber = monthsBetween(first, nextDue.slice(0, 7)) + 1;
    if (paymentNumber < 1 || paymentNumber > n + 1) return null;
    const original = amortize({ balance: originalPrincipal, rate, payment: Math.round(payment(originalPrincipal, rate, n) * 100) / 100, start: first });
    const made = paymentNumber - 1;
    const scheduledBalance = made ? original.rows[Math.min(made, original.rows.length) - 1].balance : originalPrincipal;
    // How many payments the original schedule needed to get down to today's balance.
    const reached = original.rows.findIndex((row) => row.balance <= balance + 0.5);
    const equivalent = reached < 0 ? 0 : reached + 1;
    return {
      paymentNumber, totalPayments: n, firstPayment: first,
      originalPayment: original.rows[0]?.payment ?? null,
      scheduledBalance: r2(scheduledBalance), difference: r2(scheduledBalance - balance),
      monthsAhead: equivalent - made,
    };
  }

  const api = { amortize, loanProgress, termMonths, monthsBetween, payment, ymAdd, isYm, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
