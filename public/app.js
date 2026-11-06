const PAGE_SIZE = 100;
const state = { offset: 0, total: 0, accounts: [], items: [], categories: [], view: 'overview', budgetMonth: null, trendChart: 'donut' };
const $ = (sel) => document.querySelector(sel);
const filtersForm = $('#filters');
const { el } = Charts;

const money = (n, cur = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n);
const wholeMoney = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const signedMoney = (n) => (n > 0 ? '+' : '') + money(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const prettyCat = (c) => (c ? c.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()) : '');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thisMonth = () => iso(new Date()).slice(0, 7);
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDate = (d) => SHORT_DATE.format(new Date(`${d}T00:00:00Z`));
const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const MONTH_LONG = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthDate = (m) => new Date(`${m}-01T00:00:00Z`);

// Plaid's spending categories, so you can budget for one before you've spent in it.
const SPENDING_CATEGORIES = [
  'BANK_FEES', 'ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'GENERAL_SERVICES',
  'GOVERNMENT_AND_NON_PROFIT', 'HOME_IMPROVEMENT', 'LOAN_PAYMENTS', 'MEDICAL', 'PERSONAL_CARE',
  'RENT_AND_UTILITIES', 'TRANSPORTATION', 'TRAVEL',
];
const ALL_CATEGORIES = [...SPENDING_CATEGORIES, 'INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'OTHER'];
const acctLabel = (a) => `${a.display_name}${a.mask ? ` ••${a.mask}` : ''}`;
// Transactions currently on screen, so the category dialog can find them.
const txById = new Map();

// Per-viewer conveniences only; the page works the same without storage.
const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_message || data.display_message || `Request failed (${res.status})`);
  return data;
}

function setStatus(msg) {
  $('#status').textContent = msg || '';
}

// Keep the previous render, dimmed, while new data loads.
async function withLoading(node, fn) {
  node.classList.add('loading');
  try { return await fn(); } finally { node.classList.remove('loading'); }
}

// ------------------------------------------------------------ Plaid Link --
function openLink(linkToken, { receivedRedirectUri, updateMode } = {}) {
  localStorage.setItem('plaid_link_token', linkToken);
  localStorage.setItem('plaid_link_update', updateMode ? '1' : '');
  const handler = Plaid.create({
    token: linkToken,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      localStorage.removeItem('plaid_link_token');
      if (receivedRedirectUri) history.replaceState({}, '', '/');
      try {
        if (!updateMode) {
          setStatus(`Importing ${metadata.institution?.name || 'account'}…`);
          const { sync: first } = await api('/api/exchange', { method: 'POST', body: { public_token, institution: metadata.institution } });
          // Plaid may still be preparing history for a new connection; poll briefly.
          for (let i = 0; first?.pending_initial_pull && i < 10; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const { results } = await api('/api/sync', { method: 'POST' });
            if (!results.some((r) => r.pending_initial_pull)) break;
          }
        } else {
          await api('/api/sync', { method: 'POST' });
        }
        await refreshAll();
        setStatus('Linked.');
      } catch (e) {
        alert(e.message);
        setStatus('');
      }
    },
    onExit: (err) => {
      if (receivedRedirectUri) history.replaceState({}, '', '/');
      if (err) console.warn('Plaid Link exited', err);
    },
  });
  handler.open();
}

async function startLink(itemId) {
  try {
    const { link_token } = await api('/api/link-token', { method: 'POST', body: itemId ? { item_id: itemId } : {} });
    openLink(link_token, { updateMode: !!itemId });
  } catch (e) {
    alert(`Could not start Plaid Link: ${e.message}`);
  }
}

// -------------------------------------------------------------- Accounts --
const GROUPS = [
  { key: 'cash', label: 'Cash', icon: '$', types: ['depository'] },
  { key: 'credit', label: 'Credit cards', icon: '▭', types: ['credit'], debt: true },
  { key: 'loan', label: 'Loans', icon: '⌂', types: ['loan'], debt: true },
  { key: 'investment', label: 'Investments', icon: '↗', types: ['investment', 'brokerage'] },
  { key: 'other', label: 'Other', icon: '•', types: [] },
];
const groupOf = (a) => GROUPS.find((g) => g.types.includes(a.type)) || GROUPS[GROUPS.length - 1];
// Debts count against net worth; Plaid reports what you owe as a positive balance.
const signedBalance = (a) => (a.current_balance == null ? 0 : groupOf(a).debt ? -a.current_balance : a.current_balance);

function ago(ts) {
  if (!ts) return 'never synced';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hr ago` : `${Math.round(hrs / 24)} days ago`;
}

function renderAccounts() {
  const box = $('#accounts');
  const selected = filtersForm.account_id.value;
  const collapsed = prefs.get('collapsed_groups', []);
  const itemById = Object.fromEntries(state.items.map((i) => [i.item_id, i]));
  $('#no-accounts').hidden = state.items.length > 0;
  $('#net-worth-row').hidden = state.accounts.length === 0;

  box.innerHTML = GROUPS.map((g) => {
    const accts = state.accounts.filter((a) => groupOf(a) === g);
    if (!accts.length) return '';
    const total = accts.reduce((s, a) => s + signedBalance(a), 0);
    return `<section class="acct-group ${collapsed.includes(g.key) ? 'collapsed' : ''}" data-group="${g.key}">
      <button class="group-head" data-toggle="${g.key}" aria-expanded="${!collapsed.includes(g.key)}">
        <span><span class="chev">▾</span><span class="group-icon ${g.key}" aria-hidden="true">${g.icon}</span>${esc(g.label)}</span>
        <span class="num ${total < 0 ? 'neg' : ''}">${money(total)}</span>
      </button>
      <ul class="acct-list">${accts
        .map((a) => `<li class="acct ${a.account_id === selected ? 'active' : ''}" data-account="${esc(a.account_id)}" tabindex="0">
          <span class="acct-name">${esc(a.display_name)}<button class="rename" data-rename="${esc(a.account_id)}" title="Rename" aria-label="Rename ${esc(a.display_name)}">✎</button><small>${esc(a.institution_name)}${a.mask ? ` ••${esc(a.mask)}` : ''}</small></span>
          <span class="acct-bal ${signedBalance(a) < 0 ? 'neg' : ''}">${a.current_balance == null ? '—' : money(signedBalance(a), a.iso_currency_code)}<small class="muted">${esc(ago(itemById[a.item_id]?.last_synced_at))}</small></span>
        </li>`)
        .join('')}</ul>
    </section>`;
  }).join('') + (state.items.length ? `<section class="acct-group" data-group="connections">
      <div class="group-head" style="cursor:default"><span>Connections</span></div>
      ${state.items.map((i) => `<div class="inst-actions">
          <span>${esc(i.institution_name)}</span>
          ${i.error ? `<button class="link-btn" data-relink="${esc(i.item_id)}">reconnect</button>` : ''}
          <button class="link-btn danger" data-remove="${esc(i.item_id)}">remove</button>
        </div>${i.error ? `<div class="inst-error">${esc(i.error)}</div>` : ''}`).join('')}
    </section>` : '');

  const net = state.accounts.reduce((s, a) => s + signedBalance(a), 0);
  const nw = $('#net-worth');
  nw.textContent = money(net);
  nw.className = net < 0 ? 'neg' : '';

  const sel = filtersForm.account_id;
  sel.innerHTML = '<option value="">All accounts</option>' + state.accounts
    .map((a) => `<option value="${esc(a.account_id)}">${esc(acctLabel(a))}</option>`)
    .join('');
  sel.value = selected;
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  const sel = filtersForm.category;
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + state.categories.map((c) => `<option value="${esc(c)}">${esc(prettyCat(c))}</option>`).join('');
  sel.value = current;
}

// --------------------------------------------------------------- Filters --
function periodRange(p) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = (yy, mm) => iso(new Date(yy, mm, 1));
  const last = (yy, mm) => iso(new Date(yy, mm + 1, 0));
  switch (p) {
    case 'this-month': return [first(y, m), iso(now)];
    case 'last-month': return [first(y, m - 1), last(y, m - 1)];
    case 'last-3': return [first(y, m - 2), iso(now)];
    case 'last-12': return [first(y, m - 11), iso(now)];
    case 'this-year': return [first(y, 0), iso(now)];
    case 'last-year': return [first(y - 1, 0), last(y - 1, 11)];
    default: return ['', ''];
  }
}

function currentQuery(extra = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(filtersForm)) if (v && k !== 'period') params.set(k, v);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params;
}

// --------------------------------------------------------------- Overview --
function renderAlerts(alerts) {
  const dismissed = new Set(prefs.get('dismissed_alerts', []));
  const visible = alerts.filter((a) => !dismissed.has(a.id));
  const list = $('#alerts');
  list.replaceChildren();
  $('#restore-alerts').hidden = visible.length === alerts.length;
  if (!visible.length) {
    list.appendChild(el('li', { class: 'empty-note' }, state.items.length ? 'All clear. Nothing needs your attention.' : 'Link an account to start getting alerts.'));
    return;
  }
  const ICON = { critical: '!', warning: '!', info: 'i', good: '✓' };
  for (const a of visible) {
    const li = el('li', { class: `alert ${a.level}` });
    li.appendChild(el('span', { class: 'alert-icon', 'aria-label': a.level }, ICON[a.level] || 'i'));
    const text = el('div');
    for (const p of a.parts) text.appendChild(p.strong ? el('strong', {}, p.t) : document.createTextNode(p.t));
    li.appendChild(text);
    li.appendChild(el('span', { class: 'alert-date' }, shortDate(a.date)));
    const x = el('button', { class: 'alert-dismiss', title: 'Dismiss', 'aria-label': 'Dismiss alert' }, '×');
    x.addEventListener('click', () => {
      prefs.set('dismissed_alerts', [...dismissed, a.id].slice(-200));
      renderAlerts(alerts);
    });
    li.appendChild(x);
    list.appendChild(li);
  }
}

function budgetStatus(spent, budget) {
  if (spent > budget) return 'critical';
  if (spent >= budget * 0.9) return 'warning';
  return 'good';
}

function leftLabel(spent, budget) {
  const diff = budget - spent;
  return diff >= 0
    ? el('span', {}, `${wholeMoney(diff)} left`)
    : el('span', { class: 'status-over' }, `${wholeMoney(-diff)} over`);
}

function renderOverviewBudget(summary) {
  $('#ov-budget-month').textContent = `· ${MONTH_LONG.format(monthDate(summary.month))}`;
  const box = $('#ov-budget');
  box.replaceChildren();
  if (!summary.spending.length) {
    const p = el('p', { class: 'empty-note' }, 'No budgets yet. ');
    p.appendChild(el('a', { href: '#budgets' }, 'Create a budget'));
    p.appendChild(document.createTextNode(' to track spending limits by category.'));
    box.appendChild(p);
    return;
  }
  const table = el('table');
  const head = el('tr');
  ['Category', '', 'Spent', 'Budget', 'Left'].forEach((h, i) => head.appendChild(el('th', { class: i >= 2 ? 'num' : i === 1 ? 'bar' : 'cat' }, h)));
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  const totalSpent = summary.spending.reduce((s, b) => s + b.spent, 0);
  const totalBudget = summary.spending.reduce((s, b) => s + b.budget, 0);
  const rows = [{ category: 'Total', spent: totalSpent, budget: totalBudget, total: true }, ...summary.spending];
  for (const r of rows) {
    const tr = el('tr', { class: r.total ? 'total' : '' });
    tr.appendChild(el('td', { class: 'cat' }, r.total ? 'Total' : prettyCat(r.category)));
    const barCell = el('td', { class: 'bar' });
    barCell.appendChild(Charts.meter({ value: r.spent, max: r.budget, status: budgetStatus(r.spent, r.budget), marker: summary.progress }));
    tr.appendChild(barCell);
    tr.appendChild(el('td', { class: 'num' }, wholeMoney(r.spent)));
    tr.appendChild(el('td', { class: 'num muted' }, wholeMoney(r.budget)));
    const left = el('td', { class: 'num left' });
    left.appendChild(leftLabel(r.spent, r.budget));
    tr.appendChild(left);
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);
}

function monthRows(months) {
  return months.map((m) => {
    const net = m.income - m.spending;
    return { ...m, label: MONTH_FMT.format(monthDate(m.month)), year: `’${m.month.slice(2, 4)}`, sub: MONTH_LONG.format(monthDate(m.month)), extra: { value: signedMoney(net), label: 'Net' } };
  });
}

function renderCashflow(chartEl, tableEl, months) {
  const rows = monthRows(months);
  Charts.columns(chartEl, {
    rows,
    series: [
      { key: 'income', label: 'Income', color: 'var(--series-1)' },
      { key: 'spending', label: 'Spending', color: 'var(--series-2)' },
    ],
    format: money,
  });
  Charts.table(tableEl, {
    rows,
    columns: [
      { label: 'Month', get: (r) => r.sub },
      { label: 'Income', num: true, get: (r) => money(r.income) },
      { label: 'Spending', num: true, get: (r) => money(r.spending) },
      { label: 'Net', num: true, get: (r) => money(r.income - r.spending) },
    ],
  });
}

const SOURCE_NOTE = {
  manual: 'You set this category.',
  rule: (t) => `Set by your rule “${t.rule}”.`,
  inferred: 'Guessed: Plaid had no category, so this is based on the merchant.',
  plaid: 'Category from your bank, via Plaid.',
};
const sourceNote = (t) => { const n = SOURCE_NOTE[t.category_source] || SOURCE_NOTE.plaid; return typeof n === 'function' ? n(t) : n; };

function txRow(t, acctById) {
  const a = acctById[t.account_id];
  txById.set(t.transaction_id, t);
  // Plaid: positive amount = money leaving the account.
  const out = t.amount > 0;
  return `<tr>
    <td class="date">${esc(shortDate(t.date))}</td>
    <td class="desc">
      ${t.logo_url ? `<img class="logo" src="${esc(t.logo_url)}" alt="" loading="lazy" />` : ''}
      ${esc(t.merchant_name || t.name)}${t.pending ? '<span class="badge">pending</span>' : ''}
      ${t.merchant_name && t.merchant_name !== t.name ? `<div class="sub">${esc(t.name)}</div>` : ''}
    </td>
    <td class="cat"><button type="button" class="cat-btn ${esc(t.category_source)}" data-tx="${esc(t.transaction_id)}" title="${esc(sourceNote(t))} Click to change.">${esc(prettyCat(t.category))}</button></td>
    <td>${a ? esc(acctLabel(a)) : ''}</td>
    <td class="num ${out ? 'neg' : 'pos'}">${out ? '−' : '+'}${money(Math.abs(t.amount), t.iso_currency_code)}</td>
  </tr>`;
}

const cache = {};
async function loadOverview() {
  const start = periodRange('last-12')[0];
  await withLoading($('#view-overview'), async () => {
    const [alerts, summary, insights, recent] = await Promise.all([
      api('/api/alerts'),
      api(`/api/budget-summary?month=${thisMonth()}`),
      api(`/api/insights?start=${start}`),
      api('/api/transactions?limit=8'),
    ]);
    cache.overview = { insights };
    renderAlerts(alerts);
    renderOverviewBudget(summary);
    renderCashflow($('#ov-cashflow'), $('#ov-cashflow-table'), insights.months);
    const acctById = Object.fromEntries(state.accounts.map((a) => [a.account_id, a]));
    $('#ov-recent').innerHTML = recent.transactions.length
      ? recent.transactions.map((t) => txRow(t, acctById)).join('')
      : `<tr><td class="empty">${state.items.length ? 'No transactions yet.' : 'Link an account to see transactions.'}</td></tr>`;
  });
}

// ----------------------------------------------------------- Transactions --
function renderTiles(d) {
  $('#sum-in').textContent = money(d.income);
  $('#sum-out').textContent = money(d.spending);
  const netEl = $('#sum-net');
  netEl.textContent = signedMoney(d.net);
  netEl.className = d.net >= 0 ? 'pos' : 'neg';
  const note = $('#excluded-note');
  note.hidden = !d.excluded;
  note.textContent = `Income and spending leave out ${d.excluded.toLocaleString()} transfers between your accounts and credit-card payments, so nothing is counted twice. Refunds reduce spending.`;
}

async function loadTransactionsPage() {
  const data = await api(`/api/transactions?${currentQuery({ limit: PAGE_SIZE, offset: state.offset })}`);
  state.total = data.total;
  const acctById = Object.fromEntries(state.accounts.map((a) => [a.account_id, a]));
  $('#sum-count').textContent = data.total.toLocaleString();
  $('#tx-body').innerHTML = data.transactions.length
    ? data.transactions.map((t) => txRow(t, acctById)).join('')
    : `<tr><td colspan="5" class="empty">${state.items.length ? 'No transactions match these filters.' : 'Link an account to see transactions.'}</td></tr>`;
  const from = data.total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + PAGE_SIZE, data.total);
  $('#page-info').textContent = `${from}–${to} of ${data.total.toLocaleString()}`;
  $('#prev-btn').disabled = state.offset === 0;
  $('#next-btn').disabled = to >= data.total;
}

async function loadTransactions() {
  await withLoading($('#view-transactions'), () =>
    Promise.all([loadTransactionsPage(), api(`/api/insights?${currentQuery()}`).then(renderTiles), loadRules()]),
  );
}

// ------------------------------------------------------ Category editing --
async function loadRules() {
  const rules = await api('/api/rules');
  $('#rules-count').textContent = rules.length ? `${rules.length} rule${rules.length === 1 ? '' : 's'}` : 'none yet';
  const list = $('#rules');
  list.replaceChildren();
  for (const r of rules) {
    const li = el('li', { class: 'rule-row' });
    const text = el('span');
    text.append('Contains ', el('strong', {}, `“${r.pattern}”`), ' → ', el('strong', {}, prettyCat(r.category)));
    li.appendChild(text);
    li.appendChild(el('span', { class: 'muted' }, `${r.matches} transaction${r.matches === 1 ? '' : 's'}`));
    const del = el('button', { class: 'link-btn danger', type: 'button' }, 'Delete');
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the rule for “${r.pattern}”? Its transactions go back to automatic categories.`)) return;
      await api(`/api/rules?pattern=${encodeURIComponent(r.pattern)}`, { method: 'DELETE' });
      await afterCategoryChange();
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}

// A starting point for a rule: the merchant text without card-reference noise.
const suggestPattern = (t) =>
  (t.merchant_name || t.name || '').toLowerCase().split('*')[0].replace(/\d[\d-]*/g, ' ').replace(/[#]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();

let editing = null;
function openCategoryDialog(t) {
  editing = t;
  const form = $('#cat-form');
  $('#cat-merchant').textContent = `${t.merchant_name || t.name} · ${shortDate(t.date)} · ${money(Math.abs(t.amount), t.iso_currency_code)}`;
  const options = [...new Set([...ALL_CATEGORIES, ...state.categories])].sort((a, b) => prettyCat(a).localeCompare(prettyCat(b)));
  form.category.innerHTML = options.map((c) => `<option value="${esc(c)}">${esc(prettyCat(c))}</option>`).join('');
  form.category.value = t.category;
  form.useRule.checked = t.category_source !== 'manual';
  form.pattern.value = t.rule || suggestPattern(t);
  form.pattern.disabled = !form.useRule.checked;
  $('#cat-source').textContent = sourceNote(t);
  $('#cat-reset').hidden = t.category_source !== 'manual';
  $('#cat-dialog').showModal();
  form.category.focus();
}

async function afterCategoryChange() {
  await loadCategories();
  await route();
}

async function saveCategory(body) {
  try {
    await api(`/api/transactions/${encodeURIComponent(editing.transaction_id)}/category`, { method: 'PUT', body });
    $('#cat-dialog').close();
    await afterCategoryChange();
  } catch (e) { alert(e.message); }
}

$('#cat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  saveCategory({ category: f.category.value, pattern: f.useRule.checked ? f.pattern.value : '' });
});
$('#cat-form').useRule.addEventListener('change', (e) => { $('#cat-form').pattern.disabled = !e.target.checked; });
$('#cat-cancel').addEventListener('click', () => $('#cat-dialog').close());
$('#cat-reset').addEventListener('click', () => saveCategory({ category: null }));
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-btn');
  if (btn && txById.has(btn.dataset.tx)) openCategoryDialog(txById.get(btn.dataset.tx));
});

// ---------------------------------------------------------------- Budgets --
function renderMonthChips() {
  const box = $('#month-chips');
  box.replaceChildren();
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = iso(d).slice(0, 7);
    const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(m === state.budgetMonth) });
    b.appendChild(document.createTextNode(MONTH_FMT.format(monthDate(m))));
    b.appendChild(el('small', {}, `’${m.slice(2, 4)}`));
    b.addEventListener('click', () => { state.budgetMonth = m; loadBudgets(); });
    box.appendChild(b);
  }
  const sel = box.querySelector('[aria-selected=true]');
  if (sel) box.scrollLeft = sel.offsetLeft - box.clientWidth + sel.offsetWidth + 8;
}

function budgetRow({ title, spent, budget, status, marker, onSave, onRemove, income = false }) {
  const row = el('div', { class: 'budget-row' });
  const top = el('div', { class: 'budget-row-top' });
  top.appendChild(el('strong', {}, title));
  if (budget != null) {
    if (income) {
      const diff = spent - budget;
      top.appendChild(diff >= 0 ? el('span', { class: 'pos' }, `${wholeMoney(diff)} over`) : el('span', {}, `${wholeMoney(-diff)} to go`));
    } else top.appendChild(leftLabel(spent, budget));
  }
  row.appendChild(top);
  if (budget != null) row.appendChild(Charts.meter({ value: spent, max: budget, status, marker }));
  const bottom = el('div', { class: 'budget-row-bottom' });
  bottom.appendChild(el('span', {}, budget != null ? `${money(spent)} of ${money(budget)}` : money(spent)));
  if (onSave) {
    const edit = el('button', { class: 'link-btn', type: 'button' }, budget != null ? '✎ Edit' : '+ Set expected income');
    edit.addEventListener('click', () => {
      const form = el('form', { class: 'edit-form' });
      const input = el('input', { type: 'number', min: '1', step: '1', value: budget ?? '', 'aria-label': `${title} monthly amount`, required: '' });
      const save = el('button', { class: 'btn-primary', type: 'submit' }, 'Save');
      const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
      form.append(input, save, cancel);
      if (onRemove && budget != null) {
        const rm = el('button', { class: 'link-btn danger', type: 'button' }, 'Remove budget');
        rm.addEventListener('click', onRemove);
        form.append(rm);
      }
      form.addEventListener('submit', (e) => { e.preventDefault(); onSave(Number(input.value)); });
      cancel.addEventListener('click', () => form.replaceWith(bottom));
      bottom.replaceWith(form);
      input.focus();
    });
    bottom.appendChild(edit);
  }
  row.appendChild(bottom);
  return row;
}

async function saveBudget(category, amount) {
  try {
    await api(`/api/budgets/${encodeURIComponent(category)}`, { method: 'PUT', body: { amount } });
    await loadBudgets();
  } catch (e) { alert(e.message); }
}

async function removeBudget(category) {
  if (!confirm(`Remove the ${prettyCat(category)} budget?`)) return;
  await api(`/api/budgets/${encodeURIComponent(category)}`, { method: 'DELETE' });
  await loadBudgets();
}

async function loadBudgets() {
  state.budgetMonth ||= thisMonth();
  renderMonthChips();
  $('#budget-title').textContent = MONTH_LONG.format(monthDate(state.budgetMonth));
  await withLoading($('#view-budgets'), async () => {
    const s = await api(`/api/budget-summary?month=${state.budgetMonth}`);
    const marker = s.progress;

    // Income
    $('#budget-income').replaceChildren(budgetRow({
      title: 'Income', spent: s.income.actual, budget: s.income.budget, status: 'neutral', marker, income: true,
      onSave: (amt) => saveBudget('INCOME', amt), onRemove: () => removeBudget('INCOME'),
    }));
    $('#income-head').textContent = s.income.budget != null ? `${wholeMoney(s.income.actual)} of ${wholeMoney(s.income.budget)}` : wholeMoney(s.income.actual);

    // Spending
    const sp = $('#budget-spending');
    sp.replaceChildren();
    for (const b of s.spending) {
      sp.appendChild(budgetRow({
        title: prettyCat(b.category), spent: b.spent, budget: b.budget, status: budgetStatus(b.spent, b.budget), marker,
        onSave: (amt) => saveBudget(b.category, amt), onRemove: () => removeBudget(b.category),
      }));
    }
    if (s.unbudgeted > 0 || !s.spending.length) {
      sp.appendChild(budgetRow({ title: s.spending.length ? 'Everything else' : 'All spending (no budgets yet)', spent: s.unbudgeted, budget: null }));
    }
    $('#spending-head').textContent = s.totals.budgetedSpending ? `${wholeMoney(s.totals.spending)} of ${wholeMoney(s.totals.budgetedSpending)}` : wholeMoney(s.totals.spending);

    // Add-budget choices: spending categories without a budget yet.
    const have = new Set(s.spending.map((b) => b.category));
    const options = [...new Set([...SPENDING_CATEGORIES, ...state.categories.filter((c) => !/^(INCOME|TRANSFER_)/.test(c))])]
      .filter((c) => !have.has(c))
      .sort((a, b) => prettyCat(a).localeCompare(prettyCat(b)));
    const form = $('#add-budget');
    form.hidden = !options.length;
    form.category.innerHTML = '<option value="">Choose a category…</option>' + options.map((c) => `<option value="${esc(c)}">${esc(prettyCat(c))}</option>`).join('');

    // Summary box
    const dl = $('#budget-summary');
    dl.replaceChildren();
    const line = (label, value, cls = '') => { dl.appendChild(el('dt', {}, label)); dl.appendChild(el('dd', { class: cls }, value)); };
    const sub = (text) => dl.appendChild(el('dd', { class: 'sub' }, text));
    line('Income', money(s.totals.income));
    if (s.totals.budgetedIncome != null) sub(`expected ${money(s.totals.budgetedIncome)}`);
    line('Spending', money(-s.totals.spending), 'neg');
    if (s.totals.budgetedSpending) sub(`budgeted ${money(s.totals.budgetedSpending)}`);
    dl.appendChild(el('div', { class: 'sep' }));
    line('Left over', signedMoney(s.totals.leftOver), `leftover ${s.totals.leftOver >= 0 ? 'pos' : 'neg'}`);
  });
}

$('#add-budget').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.category.value) saveBudget(f.category.value, Number(f.amount.value)).then(() => f.reset());
});

// ----------------------------------------------------------------- Trends --
function periodLabel() {
  const { start, end } = filtersForm;
  const fmt = (d) => MONTH_LONG.format(new Date(`${d}T00:00:00Z`));
  if (start.value && end.value) return `From ${fmt(start.value)} to ${fmt(end.value)}`;
  if (start.value) return `Since ${fmt(start.value)}`;
  if (end.value) return `Through ${fmt(end.value)}`;
  return 'All time';
}

function renderTrends(d) {
  $('#trend-period').textContent = periodLabel();
  const color = (slot) => (slot ? `var(--cat-${slot})` : 'var(--cat-other)');
  const label = (c) => (c.category === 'OTHER' ? `Other (${c.categories} ${c.categories === 1 ? 'category' : 'categories'})` : prettyCat(c.category));
  const drill = (c) => (c.category === 'OTHER' ? null : () => {
    filtersForm.category.value = c.category;
    location.hash = '#transactions';
  });
  const chartEl = $('#chart-categories');
  if (state.trendChart === 'donut') {
    Charts.donut(chartEl, {
      slices: d.categories.map((c) => ({ label: label(c), value: c.amount, color: color(c.slot), onClick: drill(c) })),
      format: wholeMoney,
      centerLabel: 'spent',
    });
  } else {
    Charts.bars(chartEl, {
      total: d.spending,
      format: wholeMoney,
      rows: d.categories.map((c) => ({ label: label(c), value: c.amount, color: color(c.slot), onClick: drill(c) })),
    });
  }
  Charts.table($('#table-categories'), {
    rows: d.categories,
    columns: [
      { label: 'Category', get: label },
      { label: 'Spending', num: true, get: (c) => money(c.amount) },
      { label: 'Share', num: true, get: (c) => `${d.spending > 0 ? Math.round((c.amount / d.spending) * 100) : 0}%` },
    ],
  });

  renderCashflow($('#chart-months'), $('#table-months'), d.months);

  Charts.bars($('#chart-merchants'), {
    color: 'var(--series-2)',
    total: d.spending,
    format: wholeMoney,
    rows: d.merchants.map((m) => ({
      label: m.name, value: m.amount, sub: `${m.count} transaction${m.count === 1 ? '' : 's'}`,
      onClick: () => { filtersForm.q.value = m.name; location.hash = '#transactions'; },
    })),
  });
  Charts.table($('#table-merchants'), {
    rows: d.merchants,
    columns: [
      { label: 'Merchant', get: (m) => m.name },
      { label: 'Spending', num: true, get: (m) => money(m.amount) },
      { label: 'Transactions', num: true, get: (m) => m.count.toLocaleString() },
    ],
  });
}

async function loadTrends() {
  await withLoading($('#view-trends'), async () => {
    cache.trends = await api(`/api/insights?${currentQuery()}`);
    renderTrends(cache.trends);
  });
}

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    state.trendChart = b.dataset.chart;
    prefs.set('trend_chart', state.trendChart);
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (cache.trends) renderTrends(cache.trends);
  }),
);

// ----------------------------------------------------------------- Router --
const VIEWS = { overview: loadOverview, transactions: loadTransactions, budgets: loadBudgets, trends: loadTrends };

function route() {
  const view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
  state.view = view;
  for (const v of Object.keys(VIEWS)) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  filtersForm.hidden = !(view === 'transactions' || view === 'trends');
  if (view === 'transactions') state.offset = 0;
  return VIEWS[view]().catch((e) => setStatus(e.message));
}
window.addEventListener('hashchange', route);

// Charts size to their container; redraw when the content width changes.
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (w === lastWidth) return;
  lastWidth = w;
  if (state.view === 'overview' && cache.overview) renderCashflow($('#ov-cashflow'), $('#ov-cashflow-table'), cache.overview.insights.months);
  if (state.view === 'trends' && cache.trends) renderTrends(cache.trends);
}).observe($('.content'));

async function refreshAll() {
  [state.items, state.accounts] = await Promise.all([api('/api/items'), api('/api/accounts')]);
  renderAccounts();
  await loadCategories();
  await route();
}

async function sync() {
  const btn = $('#sync-btn');
  btn.disabled = true;
  setStatus('Syncing…');
  try {
    const { results } = await api('/api/sync', { method: 'POST' });
    const added = results.reduce((s, r) => s + (r.added || 0), 0);
    const pending = results.some((r) => r.pending_initial_pull);
    await refreshAll();
    const failed = results.filter((r) => r.error).length;
    setStatus(
      failed ? `Sync failed for ${failed} institution(s)`
      : pending ? 'Bank is still preparing history — refresh again in a minute.'
      : `Synced · ${added} new`,
    );
  } catch (e) {
    setStatus(`Sync failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function exportCsv() {
  const data = await api(`/api/transactions?${currentQuery({ limit: 5000, offset: 0 })}`);
  const acctById = Object.fromEntries(state.accounts.map((a) => [a.account_id, a]));
  const rows = [['Date', 'Description', 'Merchant', 'Category', 'Account', 'Amount', 'Currency', 'Pending']];
  for (const t of data.transactions) {
    const a = acctById[t.account_id];
    rows.push([t.date, t.name, t.merchant_name || '', prettyCat(t.category), a ? acctLabel(a) : '', -t.amount, t.iso_currency_code || '', t.pending]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ----------------------------------------------------------------- Events --
let debounce;
filtersForm.addEventListener('input', (e) => {
  if (e.target.name === 'period') {
    if (e.target.value !== 'custom') {
      const [start, end] = periodRange(e.target.value);
      filtersForm.start.value = start;
      filtersForm.end.value = end;
    }
  } else if (e.target.name === 'start' || e.target.name === 'end') {
    filtersForm.period.value = filtersForm.start.value || filtersForm.end.value ? 'custom' : '';
  }
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.offset = 0;
    renderAccounts();
    route();
  }, 250);
});
filtersForm.addEventListener('submit', (e) => e.preventDefault());
$('#link-btn').addEventListener('click', () => startLink());
$('#sync-btn').addEventListener('click', sync);
$('#export-btn').addEventListener('click', () => exportCsv().catch((e) => alert(e.message)));
$('#prev-btn').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadTransactionsPage(); });
$('#next-btn').addEventListener('click', () => { state.offset += PAGE_SIZE; loadTransactionsPage(); });
$('#restore-alerts').addEventListener('click', () => { prefs.set('dismissed_alerts', []); loadOverview(); });

$('#accounts').addEventListener('click', async (e) => {
  const rename = e.target.closest('[data-rename]');
  if (rename) {
    e.stopPropagation();
    const a = state.accounts.find((x) => x.account_id === rename.dataset.rename);
    const name = prompt('Account name (leave empty to use the bank’s name):', a?.nickname || a?.display_name || '');
    if (name === null) return;
    await api(`/api/accounts/${encodeURIComponent(rename.dataset.rename)}`, { method: 'PATCH', body: { nickname: name } });
    await refreshAll();
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  const acct = e.target.closest('[data-account]');
  const remove = e.target.closest('[data-remove]');
  const relink = e.target.closest('[data-relink]');
  if (toggle) {
    const key = toggle.dataset.toggle;
    const collapsed = new Set(prefs.get('collapsed_groups', []));
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    prefs.set('collapsed_groups', [...collapsed]);
    renderAccounts();
  } else if (remove) {
    if (!confirm('Disconnect this institution and delete its stored transactions?')) return;
    await api(`/api/items/${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' });
    filtersForm.account_id.value = '';
    await refreshAll();
  } else if (relink) {
    startLink(relink.dataset.relink);
  } else if (acct) {
    // Clicking an account shows its transactions (click again to clear).
    const sel = filtersForm.account_id;
    sel.value = sel.value === acct.dataset.account ? '' : acct.dataset.account;
    renderAccounts();
    if (location.hash === '#transactions') route();
    else location.hash = '#transactions';
  }
});
$('#accounts').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-account]')) { e.preventDefault(); e.target.click(); }
});

// ------------------------------------------------------------------- Boot --
(async function boot() {
  state.trendChart = prefs.get('trend_chart', 'donut') === 'bars' ? 'bars' : 'donut';
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.chart === state.trendChart)));
  // Returning from an OAuth bank's site: resume the Link session.
  if (new URLSearchParams(location.search).has('oauth_state_id')) {
    const token = localStorage.getItem('plaid_link_token');
    const updateMode = localStorage.getItem('plaid_link_update') === '1';
    if (token) openLink(token, { receivedRedirectUri: location.href, updateMode });
  }
  try {
    await refreshAll();
    if (state.items.length) sync();
  } catch (e) {
    setStatus(e.message);
  }
})();
