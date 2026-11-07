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

  const api = { amortize, ymAdd, isYm, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
