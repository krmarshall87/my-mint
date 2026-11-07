const PAGE_SIZE = 100;
const state = { offset: 0, total: 0, accounts: [], items: [], tree: [], rules: [], view: 'overview', budgetMonth: null, trendChart: 'donut', trendParent: null };
const $ = (sel) => document.querySelector(sel);
const filtersForm = $('#filters');
const { el } = Charts;

const money = (n, cur = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n);
const wholeMoney = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const signedMoney = (n) => (n > 0 ? '+' : '') + money(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const prettyCat = (c) => (c === 'OTHER' ? 'Other' : c || 'Uncategorized');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thisMonth = () => iso(new Date()).slice(0, 7);
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDate = (d) => SHORT_DATE.format(new Date(`${d}T00:00:00Z`));
const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const MONTH_LONG = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthDate = (m) => new Date(`${m}-01T00:00:00Z`);

// The category tree (parent → subcategories) from /api/category-tree.
const parentOfCat = (c) => state.tree.find((p) => p.name === c || p.subs.includes(c))?.name || c;
const isSystemParent = (p) => p.excluded || p.name === 'Uncategorized';
// Categories you can budget for: spending only (Income has its own row).
const isBudgetable = (c) => {
  const p = state.tree.find((x) => x.name === parentOfCat(c));
  return p && !isSystemParent(p) && !p.income && parentOfCat(c) !== 'Investments';
};
// <select> options grouped by parent. A parent is itself selectable.
function categoryOptions({ filter = () => true, placeholder, parentLabel = (n) => `${n} (general)` } = {}) {
  let html = placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '';
  for (const p of state.tree) {
    const names = [p.name, ...p.subs].filter(filter);
    if (!names.length) continue;
    html += `<optgroup label="${esc(p.name)}">${names
      .map((n) => `<option value="${esc(n)}">${esc(n === p.name && p.subs.length ? parentLabel(n) : n)}</option>`)
      .join('')}</optgroup>`;
  }
  return html;
}
const catTitle = (c) => (parentOfCat(c) !== c ? `${parentOfCat(c)} › ${c}` : c);
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
  if (!state.tree.length) state.tree = await api('/api/category-tree');
  const sel = filtersForm.category;
  const current = sel.value;
  sel.innerHTML = categoryOptions({ placeholder: 'All categories', parentLabel: (n) => `All ${n}` });
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
    tr.appendChild(el('td', { class: 'cat', title: r.total ? '' : catTitle(r.category) }, r.total ? 'Total' : r.category));
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
  rule: 'Set by one of your rules.',
  inferred: 'Guessed: Plaid had no category, so this is based on the merchant.',
  plaid: 'Category from your bank, via Plaid.',
};
const sourceNote = (t) => { const n = SOURCE_NOTE[t.category_source] || SOURCE_NOTE.plaid; return typeof n === 'function' ? n(t) : n; };

// What to call a transaction: your rule's new name, then Plaid's cleaned-up merchant, then the bank's text.
const txName = (t) => t.display_name || t.merchant_name || t.name;

function txRow(t, acctById) {
  const a = acctById[t.account_id];
  txById.set(t.transaction_id, t);
  // Plaid: positive amount = money leaving the account.
  const out = t.amount > 0;
  return `<tr>
    <td class="date">${esc(shortDate(t.date))}</td>
    <td class="desc">
      ${t.logo_url ? `<img class="logo" src="${esc(t.logo_url)}" alt="" loading="lazy" />` : ''}
      ${esc(txName(t))}${t.pending ? '<span class="badge">pending</span>' : ''}${t.category === 'Hide from Budgets & Trends' ? '<span class="badge">hidden</span>' : ''}
      ${txName(t) !== t.name ? `<div class="sub">${esc(t.name)}</div>` : ''}
    </td>
    <td class="cat"><button type="button" class="cat-btn ${esc(t.category_source)}" data-tx="${esc(t.transaction_id)}" title="${esc(catTitle(t.category))}. ${esc(sourceNote(t))} Click to change.">${esc(prettyCat(t.category))}</button></td>
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
  note.textContent = `Income and spending leave out ${d.excluded.toLocaleString()} transfers, credit-card payments, investment trades and hidden transactions, so nothing is counted twice. Refunds reduce spending.`;
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
    Promise.all([loadTransactionsPage(), api(`/api/insights?${currentQuery()}`).then(renderTiles)]),
  );
}

// ------------------------------------------------------ Category editing --
// A starting point for a rule: the merchant text without card-reference noise.
const suggestPattern = (t) =>
  (t.merchant_name || t.name || '').toLowerCase().split('*')[0].replace(/\d[\d-]*/g, ' ').replace(/[#]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();

let editing = null;
function openCategoryDialog(t) {
  editing = t;
  const form = $('#cat-form');
  $('#cat-merchant').textContent = `${txName(t)} · ${shortDate(t.date)} · ${money(Math.abs(t.amount), t.iso_currency_code)}`;
  form.category.innerHTML = categoryOptions();
  form.category.value = t.category;
  form.useRule.checked = t.category_source !== 'manual';
  form.pattern.value = suggestPattern(t);
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
$('#cat-more').addEventListener('click', () => {
  const f = $('#cat-form');
  $('#cat-dialog').close();
  openRuleDialog(null, { pattern: f.pattern.value || suggestPattern(editing), category: f.category.value, from: editing });
});
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

function budgetRow({ title, parent, spent, budget, status, marker, onSave, onRemove, income = false }) {
  const row = el('div', { class: 'budget-row' });
  const top = el('div', { class: 'budget-row-top' });
  const name = el('strong', {}, title);
  if (parent) name.appendChild(el('small', { class: 'parent-label' }, parent));
  top.appendChild(name);
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
      onSave: (amt) => saveBudget('Income', amt), onRemove: () => removeBudget('Income'),
    }));
    $('#income-head').textContent = s.income.budget != null ? `${wholeMoney(s.income.actual)} of ${wholeMoney(s.income.budget)}` : wholeMoney(s.income.actual);

    // Spending
    const sp = $('#budget-spending');
    sp.replaceChildren();
    for (const b of s.spending) {
      sp.appendChild(budgetRow({
        title: b.category, parent: b.parent !== b.category ? b.parent : null, spent: b.spent, budget: b.budget, status: budgetStatus(b.spent, b.budget), marker,
        onSave: (amt) => saveBudget(b.category, amt), onRemove: () => removeBudget(b.category),
      }));
    }
    if (s.unbudgeted > 0 || !s.spending.length) {
      sp.appendChild(budgetRow({ title: s.spending.length ? 'Everything else' : 'All spending (no budgets yet)', spent: s.unbudgeted, budget: null }));
    }
    $('#spending-head').textContent = s.totals.budgetedSpending ? `${wholeMoney(s.totals.spending)} of ${wholeMoney(s.totals.budgetedSpending)}` : wholeMoney(s.totals.spending);

    // Add-budget choices: spending categories without a budget yet.
    const have = new Set(s.spending.map((b) => b.category));
    const form = $('#add-budget');
    form.category.innerHTML = categoryOptions({
      placeholder: 'Choose a category…',
      parentLabel: (n) => `All ${n}`,
      filter: (c) => isBudgetable(c) && !have.has(c),
    });

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
  const showTransactions = (category) => () => {
    filtersForm.category.value = category;
    location.hash = '#transactions';
  };
  // Top level: parent categories; click one to see its subcategories.
  const parent = state.trendParent && d.categories.find((c) => c.category === state.trendParent);
  if (!parent) state.trendParent = null;
  $('#trend-back').hidden = !parent;
  $('#trend-crumb').textContent = parent ? ` · ${parent.category}` : '';
  const items = parent
    ? parent.subs.map((s) => ({
        label: s.category === parent.category ? `${s.category} (general)` : s.category,
        value: s.amount,
        color: color(s.slot),
        onClick: showTransactions(s.category),
      }))
    : d.categories.map((c) => ({
        label: c.category === 'OTHER' ? `Other (${c.categories} ${c.categories === 1 ? 'category' : 'categories'})` : c.category,
        value: c.amount,
        color: color(c.slot),
        onClick: c.category === 'OTHER' ? null
          : c.subs.length > 1 || (c.subs.length === 1 && c.subs[0].category !== c.category)
            ? () => { state.trendParent = c.category; renderTrends(d); }
            : showTransactions(c.category),
      }));
  const total = parent ? parent.amount : d.spending;
  const chartEl = $('#chart-categories');
  if (state.trendChart === 'donut') {
    Charts.donut(chartEl, { slices: items, format: wholeMoney, centerLabel: parent ? parent.category : 'spent' });
  } else {
    Charts.bars(chartEl, { total, format: wholeMoney, rows: items });
  }
  Charts.table($('#table-categories'), {
    rows: items.map((i) => ({ category: i.label, amount: i.value })),
    columns: [
      { label: 'Category', get: (c) => c.category },
      { label: 'Spending', num: true, get: (c) => money(c.amount) },
      { label: 'Share', num: true, get: (c) => `${total > 0 ? Math.round((c.amount / total) * 100) : 0}%` },
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

$('#trend-back').addEventListener('click', () => { state.trendParent = null; if (cache.trends) renderTrends(cache.trends); });

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    state.trendChart = b.dataset.chart;
    prefs.set('trend_chart', state.trendChart);
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (cache.trends) renderTrends(cache.trends);
  }),
);


// ------------------------------------------------------------------ Rules --
const MATCH_LABEL = { contains: 'contains', starts: 'starts with', equals: 'is exactly' };
const LONG_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// "If description contains “amazon” in Chase Freedom and amount is $15.49 → rename to …, categorize as …"
function ruleSentence(r) {
  const s = el('span', { class: 'rule-sentence' });
  const b = (t) => el('strong', {}, t);
  s.append('If description ', MATCH_LABEL[r.match_type] || 'contains', ' ', b(`“${r.pattern}”`));
  if (r.account_id) {
    const a = state.accounts.find((x) => x.account_id === r.account_id);
    s.append(' in ', b(a ? acctLabel(a) : 'a removed account'));
  }
  if (r.amount_min != null && r.amount_max != null && r.amount_min === r.amount_max) s.append(' and amount is ', b(money(r.amount_min)));
  else if (r.amount_min != null && r.amount_max != null) s.append(' and amount is between ', b(money(r.amount_min)), ' and ', b(money(r.amount_max)));
  else if (r.amount_min != null) s.append(' and amount is at least ', b(money(r.amount_min)));
  else if (r.amount_max != null) s.append(' and amount is at most ', b(money(r.amount_max)));
  s.append(' → ');
  const actions = [];
  if (r.rename_to) actions.push(['rename to ', b(`“${r.rename_to}”`)]);
  if (r.category) actions.push(['categorize as ', b(r.category)]);
  actions.forEach((parts, i) => { if (i) s.append(', '); s.append(...parts); });
  if (r.start_date) s.append(el('span', { class: 'muted' }, ` (from ${LONG_DATE.format(new Date(`${r.start_date}T00:00:00Z`))})`));
  return s;
}

function renderRules() {
  const list = $('#rule-list');
  list.replaceChildren();
  if (!state.rules.length) {
    const p = el('li', { class: 'empty-note' }, 'No rules yet. Create one, or click a category in Transactions and save it as a rule.');
    list.appendChild(p);
    return;
  }
  state.rules.forEach((r, i) => {
    const li = el('li', { class: 'rule-card' });
    li.appendChild(el('span', { class: 'rule-num', 'aria-hidden': 'true' }, String(i + 1)));
    const body = el('div', { class: 'rule-body' });
    body.appendChild(ruleSentence(r));
    body.appendChild(el('small', { class: 'muted' }, r.matches ? `Applied to ${r.matches.toLocaleString()} transaction${r.matches === 1 ? '' : 's'}` : 'Not applied to any transactions yet'));
    li.appendChild(body);
    const actions = el('div', { class: 'rule-actions' });
    const btn = (label, title, fn, disabled = false) => {
      const x = el('button', { type: 'button', class: 'btn icon-btn', title, 'aria-label': title }, label);
      x.disabled = disabled;
      x.addEventListener('click', fn);
      actions.appendChild(x);
    };
    btn('↑', 'Move up', () => moveRule(i, -1), i === 0);
    btn('↓', 'Move down', () => moveRule(i, 1), i === state.rules.length - 1);
    btn('Edit', 'Edit rule', () => openRuleDialog(r));
    li.appendChild(actions);
    list.appendChild(li);
  });
}

async function loadRulesView() {
  await withLoading($('#view-rules'), async () => {
    state.rules = await api('/api/rules');
    renderRules();
  });
}

async function moveRule(i, delta) {
  const ids = state.rules.map((r) => r.id);
  [ids[i], ids[i + delta]] = [ids[i + delta], ids[i]];
  await api('/api/rules/order', { method: 'POST', body: { ids } });
  await loadRulesView();
}

let editingRule = null;
const ruleForm = $('#rule-form');

function syncAmountFields() {
  const mode = ruleForm.amount_mode.value;
  ruleForm.amount_min.hidden = mode === 'any';
  ruleForm.amount_max.hidden = mode !== 'between';
  ruleForm.querySelector('.amount-and').hidden = mode !== 'between';
  ruleForm.amount_min.placeholder = mode === 'between' ? 'From $' : '$';
}

function ruleBody() {
  const f = ruleForm;
  const mode = f.amount_mode.value;
  const min = mode === 'any' ? null : f.amount_min.value || null;
  return {
    id: editingRule?.id,
    match_type: f.match_type.value,
    pattern: f.pattern.value,
    account_id: f.account_id.value || null,
    amount_min: min,
    amount_max: mode === 'exactly' ? min : mode === 'between' ? f.amount_max.value || null : null,
    rename_to: f.rename_to.value,
    category: f.category.value || null,
    apply_past: f.apply.value === 'past',
  };
}

// Live preview: what the rule would match right now.
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const box = $('#rule-preview');
    const body = ruleBody();
    if ((body.pattern || '').trim().length < 2) {
      box.replaceChildren(el('p', { class: 'muted' }, 'Type at least 2 characters to see matching transactions.'));
      return;
    }
    try {
      const p = await api('/api/rules/preview', { method: 'POST', body });
      box.replaceChildren();
      box.appendChild(el('p', { class: 'preview-count' }, p.count ? `Matches ${p.count.toLocaleString()} transaction${p.count === 1 ? '' : 's'}` : 'No transactions match yet'));
      if (p.shadowed) box.appendChild(el('p', { class: 'hint muted' }, `${p.shadowed} of them currently follow another rule. New rules go to the top, so this one will take over.`));
      if (p.sample.length) {
        const ul = el('ul', { class: 'preview-list' });
        for (const t of p.sample) {
          const li = el('li');
          li.append(el('span', { class: 'muted' }, shortDate(t.date)), el('span', { class: 'pv-name' }, t.name), el('span', { class: 'muted pv-cat' }, t.category), el('span', { class: 'num' }, money(-t.amount)));
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }
    } catch (e) {
      box.replaceChildren(el('p', { class: 'form-error' }, e.message));
    }
  }, 250);
}

function openRuleDialog(rule, prefill = {}) {
  editingRule = rule;
  const f = ruleForm;
  f.reset();
  $('#rule-title').textContent = rule ? 'Edit rule' : 'Create rule';
  $('#rule-delete').hidden = !rule;
  $('#rule-error').hidden = true;
  f.account_id.innerHTML = '<option value="">Any account</option>' + state.accounts.map((a) => `<option value="${esc(a.account_id)}">${esc(acctLabel(a))}</option>`).join('');
  f.category.innerHTML = categoryOptions({ placeholder: 'Don’t change the category' });
  const r = rule || { match_type: 'contains', pattern: prefill.pattern || '', category: prefill.category || '', account_id: '', rename_to: '' };
  f.match_type.value = r.match_type;
  f.pattern.value = r.pattern;
  f.account_id.value = r.account_id || '';
  f.rename_to.value = r.rename_to || '';
  f.category.value = r.category || '';
  const min = r.amount_min ?? null, max = r.amount_max ?? null;
  f.amount_mode.value = min == null && max == null ? 'any' : min === max ? 'exactly' : 'between';
  f.amount_min.value = min ?? '';
  f.amount_max.value = max ?? '';
  syncAmountFields();
  f.apply.value = rule?.start_date ? 'new' : 'past';
  $('#apply-new-label').textContent = rule?.start_date
    ? `Only transactions from ${LONG_DATE.format(new Date(`${rule.start_date}T00:00:00Z`))} on`
    : 'Only new transactions, from today';
  $('#rule-dialog').showModal();
  f.pattern.focus();
  schedulePreview();
}

ruleForm.addEventListener('input', (e) => {
  if (e.target.name === 'amount_mode') syncAmountFields();
  schedulePreview();
});
ruleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = ruleBody();
  try {
    await api(editingRule ? `/api/rules/${encodeURIComponent(editingRule.id)}` : '/api/rules', { method: editingRule ? 'PUT' : 'POST', body });
    $('#rule-dialog').close();
    await afterCategoryChange();
  } catch (err) {
    const box = $('#rule-error');
    box.textContent = err.message;
    box.hidden = false;
  }
});
$('#rule-cancel').addEventListener('click', () => $('#rule-dialog').close());
$('#rule-delete').addEventListener('click', async () => {
  if (!confirm('Delete this rule? Its transactions go back to automatic names and categories.')) return;
  await api(`/api/rules/${encodeURIComponent(editingRule.id)}`, { method: 'DELETE' });
  $('#rule-dialog').close();
  await afterCategoryChange();
});
$('#new-rule').addEventListener('click', () => openRuleDialog(null));

// --------------------------------------------------------- Import rules --
let importRules = [];

async function previewImport(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch { alert('That file isn’t valid JSON.'); return; }
  importRules = Array.isArray(parsed) ? parsed : parsed?.rules;
  if (!Array.isArray(importRules)) { alert('That file has no rules in it.'); return; }
  let res;
  try { res = await api('/api/rules/import', { method: 'POST', body: { rules: importRules, dry_run: true } }); } catch (e) { alert(e.message); return; }
  const list = $('#import-list');
  list.replaceChildren();
  const skipped = res.results.filter((r) => !r.ok).length;
  $('#import-summary').textContent = `${res.will_add} new rule${res.will_add === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''}.`;
  for (const r of res.results) {
    const li = el('li', { class: `import-row ${r.ok ? '' : 'skipped'}` });
    const box = el('input', { type: 'checkbox', 'data-index': String(r.index), 'aria-label': 'Include this rule' });
    box.checked = r.ok;
    box.disabled = !r.ok;
    li.appendChild(box);
    const body = el('div', { class: 'rule-body' });
    if (r.rule) body.appendChild(ruleSentence(r.rule));
    else body.appendChild(el('span', {}, `“${r.pattern ?? '?'}”`));
    body.appendChild(el('small', { class: r.ok ? 'muted' : 'form-error' }, r.ok
      ? (r.matches ? `Would change ${r.matches} transaction${r.matches === 1 ? '' : 's'}${r.sample.length ? `, e.g. ${r.sample.map((t) => t.original).join(' · ')}` : ''}` : 'Matches nothing yet (applies to future transactions)')
      : r.error));
    li.appendChild(body);
    list.appendChild(li);
  }
  $('#import-all').checked = true;
  updateImportButton();
  $('#import-dialog').showModal();
}

function updateImportButton() {
  const n = $('#import-list').querySelectorAll('input[type=checkbox]:checked').length;
  const btn = $('#import-confirm');
  btn.textContent = `Add ${n} rule${n === 1 ? '' : 's'}`;
  btn.disabled = n === 0;
}

$('#import-rules').addEventListener('click', () => $('#rules-file').click());
$('#rules-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) previewImport(file);
});
$('#import-list').addEventListener('change', updateImportButton);
$('#import-all').addEventListener('change', (e) => {
  $('#import-list').querySelectorAll('input[type=checkbox]:not(:disabled)').forEach((b) => { b.checked = e.target.checked; });
  updateImportButton();
});
$('#import-cancel').addEventListener('click', () => $('#import-dialog').close());
$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chosen = [...$('#import-list').querySelectorAll('input[type=checkbox]:checked')].map((b) => importRules[Number(b.dataset.index)]);
  try {
    const res = await api('/api/rules/import', { method: 'POST', body: { rules: chosen } });
    $('#import-dialog').close();
    setStatus(`Imported ${res.added} rule${res.added === 1 ? '' : 's'}`);
    await afterCategoryChange();
  } catch (err) { alert(err.message); }
});

// ----------------------------------------------------------------- Router --
const VIEWS = { overview: loadOverview, transactions: loadTransactions, budgets: loadBudgets, trends: loadTrends, rules: loadRulesView };

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
  const rows = [['Date', 'Name', 'Original description', 'Category', 'Parent category', 'Account', 'Amount', 'Currency', 'Pending']];
  for (const t of data.transactions) {
    const a = acctById[t.account_id];
    rows.push([t.date, txName(t), t.name, prettyCat(t.category), parentOfCat(t.category), a ? acctLabel(a) : '', -t.amount, t.iso_currency_code || '', t.pending]);
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
