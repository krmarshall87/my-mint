// Preload for tests: replaces Plaid API calls with canned, sandbox-shaped responses.
// Dates are relative to today. STUB_MODE: ok | consent | noliab. STUB_CASH, STUB_MTG, STUB_EXPIRY_DAYS.
const { PlaidApi } = require('plaid');
const mode = process.env.STUB_MODE || 'ok';
const ok = (data) => Promise.resolve({ data });
const fail = (code) => Promise.reject(Object.assign(new Error(code), { response: { data: { error_code: code, error_message: code } } }));
const today = new Date();
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const Y = today.getUTCFullYear(), M = today.getUTCMonth(), D = today.getUTCDate();
const rel = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const CASH = Number(process.env.STUB_CASH || 3200);
const accounts = [
  { account_id: 'chk', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: CASH + 50, available: CASH } },
  { account_id: 'sav', name: 'Plaid Saving', mask: '1111', type: 'depository', subtype: 'savings', balances: { current: 5000, available: 5000 } },
  { account_id: 'citi', name: 'Citi Double Cash', mask: '2222', type: 'credit', subtype: 'credit card', balances: { current: 4000, limit: 10000 } },
  { account_id: 'chase', name: 'Chase Freedom', mask: '3333', type: 'credit', subtype: 'credit card', balances: { current: 2400, limit: 5000 } },
  { account_id: 'mtg', name: 'Home Mortgage', mask: '7777', type: 'loan', subtype: 'mortgage', balances: { current: Number(process.env.STUB_MTG || 245000) } },
  { account_id: 'car', name: 'Auto Loan', mask: '8888', type: 'loan', subtype: 'auto', balances: { current: 18500 } },
  { account_id: 'disc', name: 'Discover It', mask: '4444', type: 'credit', subtype: 'credit card', balances: { current: 900 } },
  { account_id: 'brk', name: 'Brokerage', mask: '5555', type: 'investment', subtype: 'brokerage', balances: { current: 12000 } },
  { account_id: 'ira', name: 'IRA', mask: '6666', type: 'investment', subtype: 'ira', balances: { current: 40000 } },
];
const pfc = (primary, detailed) => ({ primary, detailed });
let n = 0;
const tx = (account_id, date, name, amount, cat) => ({ transaction_id: `h${n++}`, account_id, date, name, merchant_name: name, amount, iso_currency_code: 'USD', pending: false, personal_finance_category: cat });
const added = [];
for (let k = 6; k >= 0; k--) {
  const d = (day) => ymd(Y, M - k, day);
  const push = (day, ...a) => { if (d(day) <= rel(0)) added.push(tx(a[0], d(day), ...a.slice(1))); };
  push(1, 'chk', 'ACME CORP PAYROLL', -4000, pfc('INCOME', 'INCOME_WAGES'));
  push(20, 'chk', 'INITECH PAYROLL', -3000, pfc('INCOME', 'INCOME_WAGES'));
  push(15, 'chk', 'US BANK HOME MTG', 1800, pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'));
  push(10, 'chk', 'OPPD ELECTRIC', 140 + k * 5, pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'));
  push(5, 'chase', 'NETFLIX', 15.49, pfc('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES'));
  push(8, 'chk', 'CITI CARD PAYMENT', 600, pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'));
  push(15, 'mtg', 'PAYMENT RECEIVED', -1800, null);
  push(3, 'car', 'PAYMENT', -450, null);
  push(12, 'citi', 'INTEREST CHARGE ON PURCHASES', 61.2, pfc('BANK_FEES', 'BANK_FEES_INTEREST_CHARGE'));
}
added.push(tx('citi', ymd(Y, M - 1, 28), 'PAYMENT THANK YOU', -500, pfc('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')));
added.push(tx('citi', ymd(Y, M - 1, 29), 'AMAZON REFUND', -40, pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES')));
Object.assign(PlaidApi.prototype, {
  itemPublicTokenExchange: (r) => ok({ access_token: 'access-sandbox-stub', item_id: r.public_token === 'p' ? 'item-stub' : r.public_token }),
  linkTokenCreate: (req) => {
    console.log('LINK', JSON.stringify({ c: req.additional_consented_products || null, u: req.update || null, p: req.products || null }));
    if ((req.additional_consented_products || []).includes('liabilities') && mode === 'noliab') return fail('INVALID_PRODUCT');
    return ok({ link_token: 'link-stub' });
  },
  itemRemove: () => ok({}),
  transactionsSync: () => ok({ added, modified: [], removed: [], accounts: accounts.filter((a) => a.type !== 'investment'), has_more: false, next_cursor: 'cur1' }),
  accountsGet: () => ok({ accounts }),
  itemGet: () => ok({ item: { consent_expiration_time: process.env.STUB_EXPIRY_DAYS ? new Date(Date.now() + Number(process.env.STUB_EXPIRY_DAYS) * 864e5).toISOString() : null } }),
  investmentsHoldingsGet: () => ok({ securities: [], holdings: [] }),
  investmentsTransactionsGet: () => ok({ securities: [], total_investment_transactions: 0, investment_transactions: [] }),
  liabilitiesGet: () => mode === 'consent' ? fail('ADDITIONAL_CONSENT_REQUIRED') : mode === 'noliab' ? fail('INVALID_PRODUCT') : ok({ liabilities: { credit: [
    { account_id: 'citi', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 29.99, balance_subject_to_apr: 3500, interest_charge_amount: 61.2 }, { apr_type: 'cash_apr', apr_percentage: 31.99 }], is_overdue: false,
      last_payment_amount: 500, last_payment_date: ymd(Y, M - 1, 28), last_statement_balance: 3500, last_statement_issue_date: ymd(Y, M - 1, 15), minimum_payment_amount: 105, next_payment_due_date: rel(5) },
    { account_id: 'chase', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 22.49 }], is_overdue: false,
      last_payment_amount: 1200, last_payment_date: ymd(Y, M - 1, 10), last_statement_balance: 1800, last_statement_issue_date: ymd(Y, M - 1, 22), minimum_payment_amount: 40, next_payment_due_date: rel(12) },
    { account_id: 'disc', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 0 }], is_overdue: false,
      last_payment_amount: null, last_payment_date: null, last_statement_balance: 700, last_statement_issue_date: ymd(Y, M - 1, 30), minimum_payment_amount: 35, next_payment_due_date: rel(20) },
  ], mortgage: [{ account_id: 'mtg', account_number: '3120194012', interest_rate: { percentage: 6.25, type: 'fixed' }, next_monthly_payment: 1800, next_payment_due_date: rel(8), last_payment_amount: 1800, last_payment_date: rel(-23), maturity_date: '2053-06-01', origination_date: '2023-06-01', origination_principal_amount: 255000, loan_term: '30 year', loan_type_description: 'conventional', escrow_balance: 2100.5, has_pmi: true, has_prepayment_penalty: false, past_due_amount: 0, ytd_interest_paid: 13900, ytd_principal_paid: 2600 }], student: [] } }),
});
