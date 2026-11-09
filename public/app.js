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

// Manual accounts: when they were last imported, flagged once it's been too long.
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
function importedLabel(a) {
  if (!a.last_imported_at) return 'never imported';
  const d = a.days_since_import;
  return d === 0 ? 'updated today' : d === 1 ? 'updated yesterday' : `updated ${d} days ago`;
}
function manualLine(a) {
  const url = safeUrl(a.login_url);
  return `<span class="manual-line ${a.stale ? 'stale' : ''}">
    <span title="${a.last_imported_at ? `Last import: ${esc(new Date(a.last_imported_at).toLocaleString())}` : 'No CSV imported yet'}">${a.stale ? '⚠ ' : ''}Manual · ${esc(importedLabel(a))}</span>
    <span class="manual-actions">
      <button type="button" class="link-btn" data-csv="${esc(a.account_id)}">Import CSV</button>
      ${url ? `<a class="link-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Log in ↗</a>` : ''}
    </span>
  </span>`;
}

// Open a card's or loan's Edit dialog from anywhere (alerts): go to its tab,
// and once that tab has loaded, open the dialog with the missing fields marked.
let pendingEdit = null;
function askFor(view, accountId) {
  pendingEdit = { view, accountId };
  if (location.hash === `#${view}`) VIEWS[view](); else location.hash = view;
}
function takePendingEdit(view, list, open) {
  if (pendingEdit?.view !== view) return;
  const item = list.find((x) => x.account_id === pendingEdit.accountId);
  pendingEdit = null;
  if (item) open(item, { highlight: true });
}
// Mark the inputs a dialog still needs, and focus the first.
function markNeeded(form, names) {
  for (const f of form.querySelectorAll('.field.needed')) f.classList.remove('needed');
  const inputs = names.map((n) => form[n]).filter(Boolean);
  for (const i of inputs) i.closest('.field')?.classList.add('needed');
  (inputs[0] || form.querySelector('input'))?.focus();
}
const LOAN_FIELDS_FOR = { 'interest rate': ['rate'], 'monthly payment': ['payment'] };
const CARD_FIELDS_FOR = { statement: ['statement_balance', 'statement_date', 'due_date', 'minimum_payment'], APR: ['apr'], 'credit limit': ['credit_limit'] };

const expiringSoon = (i) => i.expires_in_days != null && i.expires_in_days <= 30;
const ERROR_TEXT = {
  ITEM_LOGIN_REQUIRED: 'Sign-in expired. Click reconnect.',
};

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
        .map((a) => `<li class="acct ${a.account_id === selected ? 'active' : ''} ${a.manual ? 'manual' : ''}" data-account="${esc(a.account_id)}" tabindex="0">
          <span class="acct-name">${esc(a.display_name)}<button class="rename" data-rename="${esc(a.account_id)}" title="${a.manual ? 'Edit' : 'Rename'}" aria-label="${a.manual ? 'Edit' : 'Rename'} ${esc(a.display_name)}">✎</button><small>${esc(a.institution_name)}${a.mask ? ` ••${esc(a.mask)}` : ''}</small></span>
          <span class="acct-bal ${signedBalance(a) < 0 ? 'neg' : ''}">${a.current_balance == null ? '—' : money(signedBalance(a), a.iso_currency_code)}${a.manual ? '' : `<small class="muted">${esc(ago(itemById[a.item_id]?.last_synced_at))}</small>`}</span>
          ${a.manual ? manualLine(a) : ''}
        </li>`)
        .join('')}</ul>
    </section>`;
  }).join('') + (state.items.length ? `<section class="acct-group" data-group="connections">
      <div class="group-head" style="cursor:default"><span>Connections</span></div>
      ${state.items.map((i) => `<div class="inst-actions">
          <span>${esc(i.institution_name)}${i.manual ? ' <small class="muted">(manual)</small>' : ''}</span>
          ${i.consent_for
            ? `<button class="link-btn consent-btn" data-relink="${esc(i.item_id)}" title="Opens Plaid so this bank can share ${esc(i.consent_for)}. Only needed once.">Share ${esc(i.consent_for)}</button>`
            : i.error || expiringSoon(i) ? `<button class="link-btn" data-relink="${esc(i.item_id)}">reconnect</button>` : ''}
          <button class="link-btn danger" data-remove="${esc(i.item_id)}">remove</button>
        </div>${i.error && !i.consent_for ? `<div class="inst-error">${esc(ERROR_TEXT[i.error] || `Connection problem (${i.error}).`)}</div>`
          : expiringSoon(i) ? `<div class="inst-error">${i.expires_in_days <= 0 ? 'Connection expired. Click reconnect.' : `Connection expires ${esc(shortDate(i.consent_expires_at.slice(0, 10)))}. Reconnect to renew.`}</div>` : ''}`).join('')}
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
    for (const p of a.parts) {
      if (p.href && safeUrl(p.href)) text.appendChild(el('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, `${p.t} ↗`));
      else if (p.action === 'import' || p.action === 'edit-card' || p.action === 'edit-loan') {
        const btn = el('button', { type: 'button', class: 'link-btn inline' }, p.t);
        btn.addEventListener('click', () => (p.action === 'import' ? openCsvDialog(p.account_id) : askFor(p.action === 'edit-card' ? 'cards' : 'loans', p.account_id)));
        text.appendChild(btn);
      } else text.appendChild(p.strong ? el('strong', {}, p.t) : document.createTextNode(p.t));
    }
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


const SOURCE_NOTE = {
  manual: 'You set this category.',
  auto: 'Activity on a loan account is covered by the payment you make from checking, so it isn’t counted again.',
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
    const [alerts, summary, insights, recent, pace, recurring] = await Promise.all([
      api('/api/alerts'),
      api(`/api/budget-summary?month=${thisMonth()}`),
      api(`/api/insights?start=${start}`),
      api('/api/transactions?limit=8'),
      api('/api/spending-pace'),
      api('/api/recurring?days=30'),
    ]);
    renderUpcoming(recurring);
    cache.overview = { insights, pace };
    renderAlerts(alerts);
    renderPace(pace);
    renderOverviewBudget(summary);
    renderOverviewNet(insights.months);
    const acctById = Object.fromEntries(state.accounts.map((a) => [a.account_id, a]));
    $('#ov-recent').innerHTML = recent.transactions.length
      ? recent.transactions.map((t) => txRow(t, acctById)).join('')
      : `<tr><td class="empty">${state.items.length ? 'No transactions yet.' : 'Link an account to see transactions.'}</td></tr>`;
  });
}

// ---------------------------------------------------------------- Bills --
const billAmount = (b) => `${b.variable ? 'about ' : ''}${money(b.amount)}`;
const dueLabel = (b) => {
  const days = Math.round((Date.parse(`${b.next_date}T00:00:00Z`) - Date.parse(`${iso(new Date())}T00:00:00Z`)) / 86400000);
  if (b.overdue) return { text: `expected ${shortDate(b.next_date)}`, cls: 'late' };
  if (days === 0) return { text: 'today', cls: 'soon' };
  if (days === 1) return { text: 'tomorrow', cls: 'soon' };
  return { text: days > 60 ? `in about ${Math.round(days / 30.4)} months` : `in ${days} days`, cls: days <= 7 ? 'soon' : '' };
};

function renderUpcoming(r) {
  const box = $('#ov-upcoming');
  box.replaceChildren();
  if (!r.upcoming.length) {
    box.appendChild(el('p', { class: 'empty-note' }, state.items.length ? 'No bills expected in the next 30 days.' : 'Link an account and bills will show up here.'));
    return;
  }
  box.appendChild(el('p', { class: 'bill-total' }, `${money(r.upcoming_total)} due in the next 30 days${r.upcoming.some((b) => b.card_payment) ? ', plus card payments' : ''}`));
  const ul = el('ul');
  for (const b of r.upcoming) {
    const due = dueLabel(b);
    const li = el('li', { class: 'bill-row' });
    li.append(
      el('span', { class: `bill-date ${due.cls}` }, shortDate(b.next_date)),
      (() => { const n = el('span', { class: 'bill-name' }, b.name); n.appendChild(el('small', {}, `${b.category}${b.card_payment ? ' · not counted' : ''} · ${due.text}`)); return n; })(),
      el('span', { class: 'num' }, billAmount(b)),
    );
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

async function loadBills() {
  await withLoading($('#view-bills'), async () => {
    const r = await api('/api/recurring?days=30');
    $('#bills-monthly').textContent = money(r.monthly_total);
    $('#bills-upcoming').textContent = money(r.upcoming_total);
    const counted = r.bills.filter((b) => !b.card_payment);
    $('#bills-count').textContent = String(counted.length);
    $('#bills-subs').textContent = String(counted.filter((b) => b.amount < 30 && b.frequency === 'monthly').length);
    const body = $('#bills-body');
    body.replaceChildren();
    if (!r.bills.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '7', class: 'empty' }, 'No recurring bills found yet. They appear once a payment has repeated a few times.'));
      body.appendChild(tr);
      return;
    }
    for (const b of r.bills) {
      const due = dueLabel(b);
      const tr = el('tr', { class: b.card_payment ? 'card-payment' : '' });
      const when = el('td', { class: 'date' }, shortDate(b.next_date));
      when.appendChild(el('small', { class: `due ${due.cls}` }, due.text));
      const name = el('td', { class: 'desc' }, b.name);
      name.appendChild(el('div', { class: 'sub' }, `${b.category}${b.card_payment ? ' · not counted in totals' : ''} · paid ${b.occurrences}×`));
      tr.append(when, name, el('td', {}, b.frequency_label), el('td', { class: 'num' }, billAmount(b)), el('td', { class: 'num muted' }, b.card_payment ? '—' : money(b.monthly)), el('td', { class: 'date' }, shortDate(b.last_date)), el('td', {}, b.account || ''));
      body.appendChild(tr);
    }
  });
}

// This month's spending so far vs. last month at the same point.
function renderPace(p) {
  $('#pace-total').textContent = wholeMoney(p.total);
  const delta = $('#pace-delta');
  delta.replaceChildren();
  const thisName = MONTH_FMT.format(monthDate(p.month)), lastName = MONTH_FMT.format(monthDate(p.previous_month));
  if (p.previous.length) {
    const d = p.delta;
    const icon = el('span', { class: `delta-icon ${d > 0 ? 'up' : 'down'}`, 'aria-hidden': 'true' }, d > 0 ? '↑' : '↓');
    const msg = Math.abs(d) < 1 ? `About the same as ${lastName} at this point`
      : d > 0 ? `You’ve spent ${wholeMoney(d)} more than ${lastName} at this point` : `You’ve spent ${wholeMoney(-d)} less than ${lastName} at this point`;
    delta.append(icon, document.createTextNode(` ${msg}. ${lastName} total: ${wholeMoney(p.previous_total)}.`));
  }
  Charts.pace($('#ov-pace'), { current: p.current, previous: p.previous, days: p.days, format: wholeMoney, currentLabel: thisName, previousLabel: lastName, color: 'var(--series-1)' });
  Charts.table($('#ov-pace-table'), {
    rows: Array.from({ length: Math.max(p.days, p.previous_days) }, (_, i) => ({ day: i + 1, cur: p.current[i], prev: p.previous[i] })),
    columns: [
      { label: 'Day', get: (r) => String(r.day) },
      { label: thisName, num: true, get: (r) => (r.cur == null ? '' : money(r.cur)) },
      { label: lastName, num: true, get: (r) => (r.prev == null ? '' : money(r.prev)) },
    ],
  });
}

// Income above zero, spending below, net income as a line.
function renderNetIncome(months, chartEl = $('#chart-net-income'), tableEl = $('#table-net-income'), noteEl = $('#net-income-best')) {
  const rows = monthRows(months).map((m) => ({ ...m, up: Math.max(0, m.income), down: Math.max(0, m.spending), line: m.income - m.spending }));
  Charts.diverging(chartEl, {
    rows, format: money,
    up: { label: 'Income', color: 'var(--series-1)' },
    down: { label: 'Spending', color: 'var(--series-2)' },
    line: { label: 'Net income', color: 'var(--text)' },
  });
  const best = rows.reduce((b, r) => (b && b.line >= r.line ? b : r), null);
  noteEl.textContent = best ? `Best month: ${signedMoney(best.line)} in ${best.sub}.` : '';
  Charts.table(tableEl, {
    rows,
    columns: [
      { label: 'Month', get: (r) => r.sub },
      { label: 'Income', num: true, get: (r) => money(r.income) },
      { label: 'Spending', num: true, get: (r) => money(r.spending) },
      { label: 'Net', num: true, get: (r) => money(r.line) },
    ],
  });
}

const renderOverviewNet = (months) => renderNetIncome(months, $('#ov-cashflow'), $('#ov-cashflow-table'), $('#ov-cashflow-best'));

// Assets above zero, debts below, net worth as a line.
function renderNetWorth(nw) {
  const rows = nw.months.map((m) => ({
    label: MONTH_FMT.format(monthDate(m.month)), year: `’${m.month.slice(2, 4)}`, sub: MONTH_LONG.format(monthDate(m.month)),
    // Bars only draw positive values; tooltips and the table show the real numbers.
    up: m.assets, down: m.debts, line: m.net, estimated: m.estimated,
  }));
  Charts.diverging($('#chart-net-worth'), {
    rows, format: money,
    up: { label: 'Assets', color: 'var(--series-1)' },
    down: { label: 'Debts', color: 'var(--series-2)' },
    line: { label: 'Net worth', color: 'var(--text)' },
  });
  const est = nw.months.filter((m) => m.estimated).length;
  const since = nw.first_snapshot ? LONG_DATE.format(new Date(`${nw.first_snapshot}T00:00:00Z`)) : 'today';
  $('#net-worth-note').textContent = est
    ? `Lighter months are estimates: before ${since}, cash and card balances are worked back from your transactions, and loan and investment balances are held at their earliest recorded value (interest and market changes aren’t transactions). Balances are saved daily from now on, so new months are exact.`
    : '';
  Charts.table($('#table-net-worth'), {
    rows,
    columns: [
      { label: 'Month', get: (r) => `${r.sub}${r.estimated ? ' (estimate)' : ''}` },
      { label: 'Assets', num: true, get: (r) => money(r.up) },
      { label: 'Debts', num: true, get: (r) => money(r.down) },
      { label: 'Net worth', num: true, get: (r) => money(r.line) },
    ],
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

  renderNetIncome(d.months);
  if (cache.netWorth) renderNetWorth(cache.netWorth);

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
    [cache.trends, cache.netWorth] = await Promise.all([api(`/api/insights?${currentQuery()}`), api('/api/net-worth')]);
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


// -------------------------------------------------------- Manual accounts --
let editingManual = null;
const manualForm = $('#manual-form');

function openManualDialog(a = null) {
  editingManual = a;
  manualForm.reset();
  $('#manual-title').textContent = a ? `Edit ${a.display_name}` : 'Add a manual account';
  $('#manual-delete').hidden = !a;
  $('#manual-balance-field').hidden = !!a;
  $('#manual-error').hidden = true;
  if (a) {
    manualForm.name.value = a.name || '';
    manualForm.institution.value = a.institution_name || '';
    manualForm.type.value = a.type || 'credit';
    manualForm.mask.value = a.mask || '';
    manualForm.login_url.value = a.login_url || '';
  }
  $('#manual-dialog').showModal();
  manualForm.name.focus();
}

manualForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = manualForm;
  const body = { name: f.name.value, institution: f.institution.value, type: f.type.value, mask: f.mask.value, login_url: f.login_url.value };
  if (!editingManual) body.balance = f.balance.value;
  try {
    const saved = editingManual
      ? await api(`/api/manual-accounts/${encodeURIComponent(editingManual.account_id)}`, { method: 'PATCH', body })
      : await api('/api/manual-accounts', { method: 'POST', body });
    $('#manual-dialog').close();
    await refreshAll();
    if (!editingManual) openCsvDialog(saved.account_id); // straight to the first import
  } catch (err) {
    const box = $('#manual-error');
    box.textContent = err.message;
    box.hidden = false;
  }
});
$('#manual-cancel').addEventListener('click', () => $('#manual-dialog').close());
$('#manual-delete').addEventListener('click', async () => {
  if (!confirm(`Remove ${editingManual.display_name} and every transaction imported into it?`)) return;
  await api(`/api/items/${encodeURIComponent(editingManual.item_id)}`, { method: 'DELETE' });
  $('#manual-dialog').close();
  filtersForm.account_id.value = '';
  await refreshAll();
});
$('#add-manual').addEventListener('click', () => openManualDialog());

// ------------------------------------------------------------- CSV import --
// Parsed in the browser: the file itself never leaves your computer; only the
// rows you import are sent.
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  // Some banks put a few lines of account info above the header.
  const headerAt = Math.max(0, rows.findIndex((r) => r.some((x) => /date/i.test(x))));
  const header = rows[headerAt].map((h, i) => h.trim() || `Column ${i + 1}`);
  return { header, data: rows.slice(headerAt + 1).filter((r) => r.length >= Math.min(2, header.length)) };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/); // US: month/day/year
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (Number(m[1]) <= 12 && Number(m[2]) <= 31) return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/); // Nov 5, 2026
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})/); // 05-Nov-2026
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
function parseAmount(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bCR$/i.test(s);
  s = s.replace(/[()$€£,\s]|CR$|DR$/gi, '').replace(/^-|-$/g, '');
  const n = Number(s);
  if (!Number.isFinite(n) || s === '') return null;
  return neg ? -n : n;
}

function guessColumns(header) {
  const find = (...res) => {
    for (const re of res) { const i = header.findIndex((h) => re.test(h)); if (i >= 0) return header[i]; }
    return '';
  };
  return {
    date: find(/trans(action)?\.? ?date/i, /^date$/i, /post(ed|ing)? ?date/i, /date/i),
    description: find(/desc/i, /merchant/i, /payee/i, /^name$/i, /details|memo/i),
    amount: find(/^amount$/i, /amount/i),
    debit: find(/debit|withdraw|charge/i),
    credit: find(/credit(?!.*card)|deposit|payment/i),
  };
}

let csvState = null;
function csvAccount() { return state.accounts.find((a) => a.account_id === csvState?.accountId); }

function openCsvDialog(accountId) {
  const a = state.accounts.find((x) => x.account_id === accountId);
  if (!a) return;
  csvState = { accountId, parsed: null };
  const f = $('#csv-form');
  f.reset();
  $('#csv-title').textContent = `Import CSV · ${acctLabel(a)}`;
  $('#csv-status').textContent = a.last_imported_at
    ? `Last updated ${new Date(a.last_imported_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} (${importedLabel(a)}).`
    : 'Nothing imported yet.';
  const login = $('#csv-login');
  login.replaceChildren();
  const url = safeUrl(a.login_url);
  if (url) login.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Log in to your account ↗'), document.createTextNode(' and download your transactions as a CSV file.'));
  else login.append(document.createTextNode('Download your transactions as a CSV file from your bank’s website. (Add its login page with ✎ to get a direct link here.)'));
  $('#csv-mapping').hidden = true;
  $('#csv-error').hidden = true;
  $('#csv-import').disabled = true;
  $('#csv-dialog').showModal();
}

// Turn the parsed CSV into rows for the server, with Plaid's sign (positive = money out).
function csvRows() {
  const f = $('#csv-form');
  const { header, data } = csvState.parsed;
  const col = (name) => header.indexOf(f[name].value);
  const iDate = col('date'), iDesc = col('description'), iAmt = col('amount'), iDeb = col('debit'), iCred = col('credit');
  const purchasesPositive = f.sign.value !== 'purchases-negative';
  const rows = [], bad = [];
  for (const r of data) {
    const date = parseDate(r[iDate]);
    const description = (r[iDesc] || '').trim();
    let amount = null;
    if (iAmt >= 0) {
      const v = parseAmount(r[iAmt]);
      if (v !== null) amount = purchasesPositive ? v : -v;
    } else if (iDeb >= 0 || iCred >= 0) {
      const d = parseAmount(r[iDeb]) || 0, c = parseAmount(r[iCred]) || 0;
      if (r[iDeb]?.trim() || r[iCred]?.trim()) amount = Math.abs(d) - Math.abs(c);
    }
    if (date && description && amount !== null) rows.push({ date, description, amount: Math.round(amount * 100) / 100 });
    else bad.push(r);
  }
  return { rows, bad };
}

function renderCsvPreview() {
  const box = $('#csv-preview');
  const f = $('#csv-form');
  const { rows, bad } = csvRows();
  box.replaceChildren();
  $('#csv-import').disabled = !rows.length;
  if (!rows.length) {
    box.appendChild(el('p', { class: 'form-error' }, 'No usable rows yet. Check which columns hold the date, description and amount.'));
    return;
  }
  const dates = rows.map((r) => r.date).sort();
  const out = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const inn = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
  box.appendChild(el('p', { class: 'preview-count' }, `${rows.length.toLocaleString()} transactions, ${shortDate(dates[0])} – ${shortDate(dates[dates.length - 1])}`));
  box.appendChild(el('p', { class: 'hint muted' }, `${money(out)} out, ${money(inn)} in${bad.length ? `. ${bad.length} row${bad.length === 1 ? '' : 's'} skipped (no date or amount)` : ''}. Already-imported rows are skipped automatically.`));
  const ul = el('ul', { class: 'preview-list' });
  for (const r of rows.slice(0, 6)) {
    const li = el('li');
    li.append(el('span', { class: 'muted' }, shortDate(r.date)), el('span', { class: 'pv-name' }, r.description), el('span'), el('span', { class: `num ${r.amount > 0 ? 'neg' : 'pos'}` }, `${r.amount > 0 ? '−' : '+'}${money(Math.abs(r.amount))}`));
    ul.appendChild(li);
  }
  box.appendChild(ul);
  f.amount.closest('.field').classList.toggle('dim', !f.amount.value);
}

$('#csv-form').file.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const f = $('#csv-form');
  $('#csv-error').hidden = true;
  let parsed;
  try { parsed = parseCsv(await file.text()); } catch { parsed = null; }
  if (!parsed || !parsed.data.length) {
    const box = $('#csv-error');
    box.textContent = 'That file doesn’t look like a CSV with transactions.';
    box.hidden = false;
    return;
  }
  csvState.parsed = parsed;
  const opts = '<option value="">—</option>' + parsed.header.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
  for (const n of ['date', 'description', 'amount', 'debit', 'credit']) f[n].innerHTML = opts;
  // Reuse what worked last time for this account, if the columns are the same.
  const a = csvAccount();
  const saved = a?.column_map && ['date', 'description'].every((k) => parsed.header.includes(a.column_map[k])) ? a.column_map : null;
  const map = saved || guessColumns(parsed.header);
  for (const n of ['date', 'description', 'amount', 'debit', 'credit']) f[n].value = map[n] && parsed.header.includes(map[n]) ? map[n] : '';
  if (f.amount.value) { f.debit.value = ''; f.credit.value = ''; }
  // Sign: remembered, else cards usually list purchases as positive and bank accounts as negative.
  let sign = saved?.sign;
  if (!sign && f.amount.value) {
    const i = parsed.header.indexOf(f.amount.value);
    const vals = parsed.data.map((r) => parseAmount(r[i])).filter((v) => v !== null);
    const positives = vals.filter((v) => v > 0).length;
    sign = positives >= vals.length / 2 ? (a?.type === 'credit' ? 'purchases-positive' : 'purchases-negative') : (a?.type === 'credit' ? 'purchases-negative' : 'purchases-positive');
  }
  f.sign.value = sign || 'purchases-positive';
  $('#csv-mapping').hidden = false;
  renderCsvPreview();
});
$('#csv-mapping').addEventListener('input', (e) => {
  const f = $('#csv-form');
  if (e.target.name === 'amount' && e.target.value) { f.debit.value = ''; f.credit.value = ''; }
  if ((e.target.name === 'debit' || e.target.name === 'credit') && e.target.value) f.amount.value = '';
  renderCsvPreview();
});
$('#csv-cancel').addEventListener('click', () => $('#csv-dialog').close());
$('#csv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('#csv-form');
  const { rows } = csvRows();
  const column_map = { date: f.date.value, description: f.description.value, amount: f.amount.value, debit: f.debit.value, credit: f.credit.value, sign: f.sign.value };
  const btn = $('#csv-import');
  btn.disabled = true;
  try {
    const r = await api(`/api/manual-accounts/${encodeURIComponent(csvState.accountId)}/import`, { method: 'POST', body: { rows, column_map, balance: f.balance.value } });
    $('#csv-dialog').close();
    setStatus(`Imported ${r.added.toLocaleString()} new transaction${r.added === 1 ? '' : 's'}${r.already ? ` (${r.already.toLocaleString()} already there)` : ''}`);
    await refreshAll();
  } catch (err) {
    const box = $('#csv-error');
    box.textContent = err.message;
    box.hidden = false;
    btn.disabled = false;
  }
});



// Links to what each bank actually sent Plaid, unprocessed (opens in a new tab).
function rawLinks(node, status) {
  node.replaceChildren();
  const banks = status.filter((x) => x.item_id);
  if (!banks.length) return;
  node.append('What each bank sent, unprocessed: ');
  banks.forEach((b, i) => {
    if (i) node.append(' · ');
    node.append(`${b.institution} (`);
    const LINKS = { liabilities: 'statements', accounts: 'balances & limits', item: 'permissions', institution: 'what the bank supports' };
    Object.entries(LINKS).forEach(([product, label], j) => {
      if (j) node.append(', ');
      node.append(el('a', { href: `/api/plaid-raw/${encodeURIComponent(b.item_id)}/${product}`, target: '_blank', rel: 'noopener noreferrer' }, label));
    });
    node.append(')');
  });
}

// Per-bank notes for an optional product; banks waiting for your OK share one note.
function consentNotes(status, what, texts) {
  const waiting = status.filter((x) => x.status === 'ADDITIONAL_CONSENT_REQUIRED').map((x) => x.institution);
  const out = [];
  if (waiting.length) {
    const p = el('p', { class: 'note-box' });
    p.append(el('strong', {}, waiting.join(', ')), ` ${waiting.length > 1 ? 'need' : 'needs'} your OK to share ${what}. Click “Share” next to ${waiting.length > 1 ? 'each bank' : 'it'} in the accounts list.`);
    out.push(p);
  }
  for (const x of status.filter((s) => s.status && s.status !== 'ADDITIONAL_CONSENT_REQUIRED')) {
    const p = el('p', { class: 'note-box' });
    p.append(el('strong', {}, x.institution), ` ${texts[x.status] || `couldn’t share ${what} (${x.status}).`}`);
    out.push(p);
  }
  return out;
}

// ----------------------------------------------------------- Credit cards --
const CARD_STATUS = {
  PRODUCTS_NOT_SUPPORTED: 'doesn’t share card statements through Plaid. Click Edit on its cards to add them yourself.',
  INVALID_PRODUCT: 'can’t share card statements yet: turn on the Liabilities product in your Plaid dashboard, or click Edit to add them yourself.',
  PRODUCT_NOT_READY: 'is still preparing card statements. They’ll appear after the next update.',
  NO_LIABILITY_ACCOUNTS: 'didn’t report any card statements.',
};
const cardBuffer = () => {
  const v = Number(prefs.get('cardBuffer', 500));
  return Number.isFinite(v) && v >= 0 ? v : 500;
};
const noteBox = (level, ...parts) => {
  const p = el('p', { class: `note-box ${level}` });
  p.append(...parts.map((x) => (typeof x === 'string' ? x : x)));
  return p;
};
const strong = (t) => el('strong', {}, t);
// Credit utilization: under 10% is great, over 30% starts to hurt a credit score. Always with a label.
function utilBadge(pct) {
  const [cls, label] = pct > 30 ? ['util-high', 'over 30%'] : pct <= 10 ? ['util-good', 'low'] : ['util-ok', 'OK'];
  return el('span', { class: `badge ${cls}` }, label);
}
const aprText = (c) => (c.promo ? `${c.promo.apr}% promo` : `${Number(c.apr).toFixed(2)}%`);

async function loadCards() {
  const input = $('#card-buffer');
  if (document.activeElement !== input) input.value = String(cardBuffer());
  await withLoading($('#view-cards'), async () => {
    const d = await api(`/api/card-plan?buffer=${encodeURIComponent(cardBuffer())}`);
    const t = d.totals;
    $('#card-window').textContent = `Planning through ${shortDate(d.end)}; bills and paychecks are looked at through ${shortDate(d.through)} so next month’s bills stay covered.`;

    const status = $('#card-status');
    status.replaceChildren(...consentNotes(d.status, 'card statements', CARD_STATUS));
    rawLinks($('#card-raw'), d.status);

    const warn = $('#card-warnings');
    warn.replaceChildren();
    if (t.below_buffer > 0) {
      warn.appendChild(noteBox('critical', strong('Checking runs short. '),
        `Bills alone take it to ${money(t.lowest_balance)} on ${shortDate(t.lowest_date)}, ${money(t.below_buffer)} under your ${money(d.buffer)} buffer, before any card payment.`));
    }
    if (t.missed_minimums) {
      warn.appendChild(noteBox('critical', strong('A minimum payment can’t be made on time. '),
        `${money(t.minimum_short)} of minimums doesn’t fit before the due date${t.missed_minimums > 1 ? 's' : ''}; it’s planned for right after the next paycheck, but a late fee is likely. Moving money from savings (or a smaller buffer) avoids it.`));
    }
    const missing = d.cards.filter((c) => c.needs_details && c.balance > 0);
    if (missing.length) {
      warn.appendChild(noteBox('', strong(`${missing.length} card${missing.length > 1 ? 's' : ''} without a statement. `),
        'Without a statement balance and due date, the plan can’t include ', missing.map((c) => c.name).join(', '), '. Click Edit to add them.'));
    }
    if (!t.below_buffer && !t.missed_minimums && t.due > 0 && t.unpaid === 0) {
      warn.appendChild(noteBox('good', strong('Every statement can be paid in full on time. '), `No interest this month, and ${money(t.left_over)} stays in checking above your buffer.`));
    }

    $('#cp-checking').textContent = money(d.checking.total);
    $('#cp-income').textContent = money(t.income);
    $('#cp-bills').textContent = money(t.bills);
    $('#cp-due').textContent = money(t.due);
    $('#cp-pay').textContent = money(t.pay);
    $('#cp-interest').textContent = t.interest ? `~${money(t.interest)}` : money(0);
    $('#cp-interest-ytd').textContent = money(t.interest_ytd);
    $('#cp-util').replaceChildren(...(t.utilization == null ? ['—'] : [`${Math.round(t.utilization)}%`, utilBadge(t.utilization)]));
    $('#cp-util-note').textContent = t.utilization == null ? 'Add credit limits to see this' : `of ${wholeMoney(t.credit_limit)}${t.cards_without_limit ? ` · ${t.cards_without_limit} card${t.cards_without_limit > 1 ? 's' : ''} without a limit` : ''}`;
    for (const id of ['cp-income', 'cp-bills']) $(`#${id}`).previousElementSibling.textContent = `${id === 'cp-income' ? 'Paychecks' : 'Bills'} to ${shortDate(d.through)}`;

    renderPlanTable(d);
    takePendingEdit('cards', d.cards, openCardDialog);
    renderSuggestions(d);
    renderOutlook(d);
    renderIncome(d);
  });
}

function renderPlanTable(d) {
  const table = $('#card-plan-table');
  table.replaceChildren();
  const head = el('tr');
  ['Card', 'Still owed', 'Minimum', 'APR', 'Due', 'Plan', 'Interest', ''].forEach((h, i) => head.appendChild(el('th', { class: [1, 2, 3, 6].includes(i) ? 'num' : '' }, h)));
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  if (!d.cards.length) {
    const tr = el('tr');
    tr.appendChild(el('td', { colspan: 8, class: 'muted' }, 'No credit cards linked yet.'));
    body.appendChild(tr);
  }
  const incomeOn = (date) => d.timeline.find((e) => e.type === 'income' && e.date === date);
  for (const c of d.cards) {
    const tr = el('tr');
    const name = el('td', { class: 'desc' });
    name.append(el('strong', {}, c.name));
    const sub = c.statement_date
      ? `Statement ${shortDate(c.statement_date)}: ${money(c.statement_balance)}${c.paid_since_statement ? `, ${money(c.paid_since_statement)} paid since` : ''}${c.source === 'you' ? ' (yours)' : ''}`
      : `Balance ${money(c.balance || 0)} · no statement yet`;
    name.append(el('div', { class: 'sub' }, sub));
    if (c.credit_limit) {
      const u = el('div', { class: 'sub' }, `${Math.round(c.utilization)}% of ${wholeMoney(c.credit_limit)} limit`);
      u.append(utilBadge(c.utilization));
      if (c.to_30 > 0) u.title = `Paying ${money(c.to_30)} more brings it under 30%`;
      name.append(u);
    }
    const owed = el('td', { class: 'num' }, c.remaining == null ? '—' : money(c.remaining));
    const minMet = c.minimum === 0 && c.minimum_payment > 0 && c.remaining > 0;
    const min = el('td', { class: 'num' }, c.minimum == null ? '—' : minMet ? '✓ met' : `${money(c.minimum)}${c.minimum_estimated ? '*' : ''}`);
    if (minMet) min.title = `The ${money(c.minimum_payment)} minimum is covered by payments since the statement`;
    if (c.minimum_estimated) min.title = 'Estimated: your bank didn’t report the minimum';
    const apr = el('td', { class: 'num' });
    apr.append(aprText(c));
    if (c.apr_assumed) apr.append(el('span', { class: 'badge', title: 'Your bank didn’t report the APR. Click Edit to add it.' }, 'assumed'));
    if (c.promo_ending) apr.append(el('div', { class: 'sub muted' }, `promo ends ${shortDate(c.promo_ending)}`));
    else if (c.promo?.end) apr.append(el('div', { class: 'sub muted' }, `until ${shortDate(c.promo.end)}`));
    const due = el('td', {}, c.due_date ? shortDate(c.due_date) : '—');
    if (c.overdue) due.append(el('span', { class: 'badge' }, 'past due'));

    const plan = el('td');
    const steps = el('ul', { class: 'plan-steps' });
    if (c.needs_details) steps.appendChild(el('li', { class: 'muted' }, 'Add the statement to plan this card'));
    else if (!c.remaining) steps.appendChild(el('li', {}, c.statement_balance ? '✓ Statement paid' : 'Nothing due'));
    for (const p of c.payments || []) {
      const li = el('li');
      if (!p.late) {
        li.append(strong(`Pay ${money(p.amount)}`), ` by ${shortDate(c.due_date)}`);
        const fb = c.funded_by;
        li.append(el('span', { class: 'sub muted' }, fb === 'checking' ? 'money’s there now' : fb ? `after ${fb.name} on ${shortDate(fb.date)}` : ''));
      } else {
        const pay = incomeOn(p.date);
        li.append(strong(`Then ${money(p.amount)}`), ` on ${shortDate(p.date)}`);
        li.append(el('span', { class: 'sub muted' }, pay ? `after ${pay.name}, to cut interest` : 'as soon as there’s room, to cut interest'));
      }
      steps.appendChild(li);
    }
    if (c.remaining > 0 && !c.payments?.length) steps.appendChild(el('li', {}, strong('No money for this card'), el('span', { class: 'sub muted' }, 'see the suggestions below')));
    if (c.promo && !c.promo_ending && c.unpaid > 0 && c.payments?.length) steps.appendChild(el('li', { class: 'muted' }, `${money(c.unpaid)} left on the 0% promo`));
    if (c.promo_ending && c.balance > 0) steps.appendChild(el('li', {}, strong(`Pay off all ${money(c.balance)} by ${shortDate(c.promo_ending)}`), el('span', { class: 'sub muted' }, 'when the promo ends, interest may be charged back to the purchase date')));
    plan.appendChild(steps);

    const interest = el('td', { class: 'num interest-cell' });
    if (c.interest_cost) interest.append(`~${money(c.interest_cost)}`);
    else interest.append(c.remaining > 0 ? '$0' : '—');
    if (c.interest_if_unpaid > c.interest_cost) interest.append(el('div', { class: 'sub muted' }, `saves ~${money(c.interest_if_unpaid - c.interest_cost)}`));
    if (c.interest_charged != null) interest.append(el('div', { class: 'sub muted' }, `${money(c.interest_charged)} on last statement`));
    if (c.interest_ytd) interest.append(el('div', { class: 'sub muted' }, `${money(c.interest_ytd)} this year`));

    const edit = el('td');
    const needs = c.missing?.length;
    const btn = el('button', { type: 'button', class: needs ? 'link-btn attention' : 'link-btn', title: needs ? `Missing: ${c.missing.join(', ')}` : '' }, needs ? 'Add details' : 'Edit');
    btn.addEventListener('click', () => openCardDialog(c, { highlight: !!needs }));
    edit.appendChild(btn);
    plan.className = 'plan-cell';
    edit.className = 'edit-cell';
    [[owed, 'Still owed'], [min, 'Minimum'], [apr, 'APR'], [due, 'Due'], [plan, 'Plan'], [interest, 'Interest']].forEach(([td, label]) => td.setAttribute('data-label', label));
    tr.append(name, owed, min, apr, due, plan, interest, edit);
    body.appendChild(tr);
  }
  table.appendChild(body);
}

function renderSuggestions(d) {
  const box = $('#card-suggestions');
  box.replaceChildren();
  for (const s of d.suggestions) {
    const from = s.accounts.join(', ');
    if (s.type === 'savings') {
      box.appendChild(noteBox('info', strong(`Consider moving ${money(s.amount)} from savings`), ` (${from}) to checking. `,
        s.interest_saved > 0 ? `It would pay the cards on time and save about ${money(s.interest_saved)} in interest this month.` : 'It would keep checking above your buffer and every payment on time.'));
    } else {
      box.appendChild(noteBox('info', strong(`Your card debt is over ${money(d.invest_threshold)}. `),
        `Selling ${money(s.amount)} from ${from} would cover the rest${s.interest_saved > 0 ? ` and save about ${money(s.interest_saved)} a month in interest` : ''}. Card interest usually costs more than investments earn, but selling can mean capital-gains tax. Retirement accounts are never suggested.`));
    }
  }
}

function renderOutlook(d) {
  // One point per day from today, with that day's events.
  const days = [];
  const start = new Date(`${d.today}T00:00:00Z`), end = new Date(`${d.through}T00:00:00Z`);
  let bal = d.checking.total;
  for (let t = start; t <= end; t = new Date(t.getTime() + 86400000)) {
    const date = t.toISOString().slice(0, 10);
    const events = d.timeline.filter((e) => e.date === date).map((e) => ({ name: e.type === 'card' ? `${e.name}${e.late ? ' (extra)' : ''}` : e.name, amount: e.amount, card: e.type === 'card' }));
    bal = events.reduce((s, e) => s + e.amount, bal);
    days.push({ date: shortDate(date), label: shortDate(date), balance: Math.round(bal * 100) / 100, events });
  }
  Charts.outlook($('#card-outlook'), { days, buffer: d.buffer, format: wholeMoney, color: 'var(--series-1)' });
  Charts.table($('#card-outlook-table'), {
    rows: d.timeline,
    columns: [
      { label: 'Date', get: (e) => shortDate(e.date) },
      { label: 'What', get: (e) => `${e.type === 'card' ? `Pay ${e.name}${e.late ? ' (extra)' : ''}` : e.name}${e.variable ? ' (about)' : ''}` },
      { label: 'Amount', num: true, get: (e) => signedMoney(e.amount) },
      { label: 'Checking after', num: true, get: (e) => money(e.balance) },
    ],
  });
}

function renderIncome(d) {
  const table = $('#card-income-table');
  table.replaceChildren();
  const head = el('tr');
  ['Paid by', 'How often', 'Typical', 'Last', 'Next'].forEach((h, i) => head.appendChild(el('th', { class: i === 2 ? 'num' : '' }, h)));
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  if (!d.income.length) {
    const tr = el('tr');
    tr.appendChild(el('td', { colspan: 5, class: 'muted' }, 'No regular paychecks found in checking yet. Make sure paychecks are in an Income category (Paycheck), for example with a rule.'));
    body.appendChild(tr);
  }
  for (const p of d.income) {
    const tr = el('tr');
    tr.append(el('td', { class: 'desc' }, p.name), el('td', {}, p.frequency_label), el('td', { class: 'num' }, money(p.amount)),
      el('td', {}, shortDate(p.last_date)), el('td', {}, p.next_date ? shortDate(p.next_date) : '—'));
    body.appendChild(tr);
  }
  table.appendChild(body);
}

let bufferTimer = null;
$('#card-buffer').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v < 0) return;
  prefs.set('cardBuffer', v);
  clearTimeout(bufferTimer);
  bufferTimer = setTimeout(loadCards, 400);
});

let editingCard = null;
const cardForm = $('#card-form');
function openCardDialog(c, { highlight = false } = {}) {
  editingCard = c;
  cardForm.reset();
  $('#card-error').hidden = true;
  $('#card-title').textContent = c.name;
  const fromBank = c.source === 'plaid';
  $('#card-dialog-note').textContent = fromBank
    ? 'Your bank shares this card’s statement. Add what it leaves out, like a promo rate. Anything left blank uses your bank’s value.'
    : 'Your bank doesn’t share this card’s statement, so add it from the card’s website or paper statement.';
  const mine = c.mine || {};
  const set = (k, v, ph) => { cardForm[k].value = v ?? ''; cardForm[k].placeholder = ph ?? ''; };
  set('apr', mine.apr, c.apr_assumed ? 'not reported' : String(c.regular_apr ?? c.apr));
  set('credit_limit', mine.credit_limit, c.credit_limit_source === 'bank' ? String(c.credit_limit) : 'not reported');
  set('promo_apr', mine.promo_apr, '');
  set('promo_end', mine.promo_end);
  set('statement_balance', c.source === 'you' ? c.statement_balance : mine.statement_balance, fromBank ? String(c.statement_balance) : '');
  set('statement_date', c.source === 'you' ? c.statement_date : mine.statement_date);
  set('due_date', c.source === 'you' ? c.due_date : mine.due_date);
  set('minimum_payment', c.source === 'you' ? c.minimum_payment : mine.minimum_payment, fromBank && c.minimum_payment != null ? String(c.minimum_payment) : '');
  $('#card-dialog').showModal();
  markNeeded(cardForm, highlight ? (c.missing || []).flatMap((m) => CARD_FIELDS_FOR[m] || []) : []);
}
cardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ['credit_limit', 'apr', 'promo_apr', 'promo_end', 'statement_balance', 'statement_date', 'due_date', 'minimum_payment']) body[k] = cardForm[k].value;
  try {
    await api(`/api/cards/${encodeURIComponent(editingCard.account_id)}`, { method: 'PUT', body });
    $('#card-dialog').close();
    await loadCards();
  } catch (err) {
    const box = $('#card-error');
    box.textContent = err.message;
    box.hidden = false;
  }
});
$('#card-cancel').addEventListener('click', () => $('#card-dialog').close());
$('#card-clear').addEventListener('click', async () => {
  await api(`/api/cards/${encodeURIComponent(editingCard.account_id)}`, { method: 'PUT', body: {} });
  $('#card-dialog').close();
  await loadCards();
});


// ------------------------------------------------------------------ Loans --
const LOAN_STATUS = {
  PRODUCTS_NOT_SUPPORTED: 'doesn’t share loan details through Plaid. Click Edit on its loans to add them yourself.',
  INVALID_PRODUCT: 'can’t share loan details yet: turn on the Liabilities product in your Plaid dashboard, or click Edit to add them yourself.',
  PRODUCT_NOT_READY: 'is still preparing loan details. They’ll appear after the next update.',
};
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
const FULL_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fullDate = (d) => FULL_DATE.format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
const ymLabel = (ym) => MONTH_YEAR.format(new Date(`${ym}-01T00:00:00Z`));
const SOURCE = { bank: 'from your bank', you: 'yours', calculated: 'calculated', payments: 'from your payments' };


async function loadLoans() {
  await withLoading($('#view-loans'), async () => {
    const d = await api('/api/loans');
    $('#loan-status').replaceChildren(...consentNotes(d.status, 'loan details', LOAN_STATUS));
    rawLinks($('#loan-raw'), d.status);
    const list = $('#loans-list');
    list.replaceChildren();
    if (!d.loans.length) list.appendChild(el('p', { class: 'panel muted empty-note' }, 'No loans linked yet. Mortgages and loans appear here once a bank shares them, or add one with + Add manual account (type Loan).'));
    const order = (l) => (l.kind === 'mortgage' ? 0 : 1);
    for (const loan of [...d.loans].sort((x, y) => order(x) - order(y) || y.balance - x.balance)) list.appendChild(loanPanel(loan, d.today));
    takePendingEdit('loans', d.loans, openLoanDialog);
  });
}

function loanPanel(loan, today) {
  const panel = el('div', { class: 'panel loan' });
  const head = el('div', { class: 'panel-head' });
  const title = el('div');
  const kind = { mortgage: 'Mortgage', student: 'Student loan', auto: 'Car loan' }[loan.kind] || 'Loan';
  title.append(el('h2', {}, loan.name), el('p', { class: 'muted subhead' }, `${kind}${loan.loan_type ? ` · ${loan.loan_type}` : ''}${loan.institution ? ` · ${loan.institution}` : ''}`));
  const edit = el('button', { type: 'button', class: 'btn' }, 'Edit');
  edit.addEventListener('click', () => openLoanDialog(loan));
  const right = el('div', { class: 'loan-head-right' });
  right.append(el('strong', { class: 'head-figure' }, money(loan.balance)), edit);
  head.append(title, right);
  panel.appendChild(head);
  const body = el('div', { class: 'panel-body loan-body' });
  panel.appendChild(body);

  // Facts, each with where it came from.
  const facts = el('dl', { class: 'loan-facts' });
  const fact = (label, value, source, note) => {
    const wrap = el('div');
    wrap.append(el('dt', {}, label));
    const dd = el('dd', {}, value);
    if (source) dd.append(el('span', { class: 'src' }, SOURCE[source] || source));
    if (note) dd.append(el('span', { class: 'src' }, note));
    wrap.appendChild(dd);
    facts.appendChild(wrap);
  };
  const dateText = (d) => (d ? fullDate(d) : '—');
  fact('Interest rate', loan.rate.value == null ? 'not known' : `${loan.rate.value}%${loan.rate_type ? ` ${loan.rate_type}` : ''}`, loan.rate.source);
  fact('Principal & interest', loan.payment.value == null ? 'not known' : `${money(loan.payment.value)}/mo`, loan.payment.source);
  if (loan.kind === 'mortgage' || loan.escrow.value != null) fact('Escrow', loan.escrow.value == null ? '—' : `${money(loan.escrow.value)}/mo`, loan.escrow.source);
  if (loan.total_payment != null) fact('Total payment', `${money(loan.total_payment)}/mo`, loan.total_payment_source);
  fact('Next payment due', dateText(loan.next_due_date.value), loan.next_due_date.source);
  fact('Scheduled payoff', dateText(loan.maturity_date.value), loan.maturity_date.source);
  if (loan.original_principal.value != null) fact('Original amount', money(loan.original_principal.value), loan.original_principal.source, loan.origination_date.value ? `taken ${fullDate(loan.origination_date.value)}` : null);
  if (loan.ytd_interest != null) fact('Paid this year', `${money(loan.ytd_interest)} interest`, null, loan.ytd_principal != null ? `${money(loan.ytd_principal)} principal` : null);
  if (loan.escrow_balance != null) fact('Escrow balance', money(loan.escrow_balance));
  if (loan.has_pmi != null) fact('PMI', loan.has_pmi ? 'Yes' : 'No', null, loan.has_pmi ? 'usually removable at 20% equity' : null);
  body.appendChild(facts);
  if (loan.has_prepayment_penalty) body.appendChild(el('p', { class: 'note-box' }, el('strong', {}, 'This loan has a prepayment penalty. '), 'Check its terms before paying extra.'));
  if (loan.past_due) body.appendChild(el('p', { class: 'note-box critical' }, el('strong', {}, 'Past due: '), `${money(loan.past_due)}.`));

  if (!(loan.balance > 0)) {
    body.appendChild(el('p', { class: 'note-box good' }, el('strong', {}, 'Paid off: '), 'nothing left to schedule.'));
    return panel;
  }
  if (loan.missing.length) {
    const ask = el('div', { class: 'note-box ask' });
    const btn = el('button', { type: 'button', class: 'btn-primary' }, `Add the ${loan.missing.join(' and ')}`);
    btn.addEventListener('click', () => openLoanDialog(loan, { highlight: true }));
    ask.append(el('p', {}, el('strong', {}, `Add the ${loan.missing.join(' and ')} to see the payoff schedule and what-ifs. `),
      `Your bank doesn’t share it for this loan; it’s on your loan statement or the lender’s website.`), btn);
    body.appendChild(ask);
    return panel;
  }

  // Schedule starts with the next payment.
  const nextDue = loan.next_due_date.value && loan.next_due_date.value >= today ? loan.next_due_date.value.slice(0, 7) : ymAdd(today.slice(0, 7), 1);
  const base = amortize({ balance: loan.balance, rate: loan.rate.value, payment: loan.payment.value, start: nextDue });

  // Against the original schedule: which payment this is, and ahead or behind.
  const progress = loanProgress({
    originalPrincipal: loan.original_principal.value, rate: loan.rate.value, term: loan.loan_term,
    origination: loan.origination_date.value, maturity: loan.maturity_date.value, nextDue: `${nextDue}-01`, balance: loan.balance,
  });
  if (progress) {
    fact('Payment number', `#${progress.paymentNumber} of ${progress.totalPayments}`, 'calculated', `${progress.totalPayments - progress.paymentNumber + 1} left on the original schedule`);
    const m = progress.monthsAhead, gap = Math.abs(progress.difference);
    const [text, note] = Math.abs(m) <= 0 && gap < 200 ? ['On schedule', `balance matches the original ${money(progress.originalPayment)}/mo schedule`]
      : m > 0 ? [`${m} month${m === 1 ? '' : 's'} ahead`, `${money(gap)} less owed than the original schedule`]
      : [`${-m} month${m === -1 ? '' : 's'} behind`, `${money(gap)} more owed than the original schedule`];
    fact('Progress', text, 'calculated', note);
  }
  const offset = progress ? progress.paymentNumber - 1 : 0;
  if (base.never) {
    body.appendChild(el('p', { class: 'note-box critical' }, el('strong', {}, 'This payment doesn’t cover the interest, '), 'so the balance never goes down. Check the rate and payment with Edit.'));
    return panel;
  }

  // What-if: extra every month and/or a one-time payment. Remembered in this browser.
  const key = `loanWhatIf:${loan.account_id}`;
  const saved = prefs.get(key, {});
  const box = el('div', { class: 'whatif' });
  box.appendChild(el('h3', {}, 'What if I pay more?'));
  const row = el('div', { class: 'whatif-inputs' });
  const moneyField = (label, value) => {
    const lab = el('label', { class: 'field' }, label);
    const wrap = el('span', { class: 'money-input' });
    const input = el('input', { type: 'number', min: '0', step: '50', inputmode: 'decimal', value: value ?? '' });
    wrap.append(el('span', { 'aria-hidden': 'true' }, '$'), input);
    lab.appendChild(wrap);
    return [lab, input];
  };
  const monthField = (label, value) => {
    const lab = el('label', { class: 'field' }, label);
    const input = el('input', { type: 'month', value: value || nextDue, min: nextDue });
    lab.appendChild(input);
    return [lab, input];
  };
  const [l1, extraIn] = moneyField('Extra each month', saved.extra);
  const [l2, fromIn] = monthField('Starting', saved.from);
  const [l3, lumpIn] = moneyField('One-time payment', saved.lump);
  const [l4, lumpAtIn] = monthField('In', saved.lumpAt);
  const l5 = el('label', { class: 'field' }, 'One-time payment should');
  const modeIn = el('select');
  modeIn.append(el('option', { value: 'shorten' }, 'Shorten the loan'), el('option', { value: 'recast' }, 'Lower my payment (recast)'));
  modeIn.value = saved.mode === 'recast' ? 'recast' : 'shorten';
  modeIn.title = 'Shorten: the payment stays the same, so the loan ends sooner. Recast: the lender re-spreads the balance over the same payoff date, so the monthly payment drops (lenders often charge a small fee and require a minimum amount).';
  l5.appendChild(modeIn);
  const reset = el('button', { type: 'button', class: 'link-btn' }, 'Reset');
  row.append(l1, l2, l3, l4, l5, reset);
  box.appendChild(row);
  const results = el('div', { class: 'summary whatif-results' });
  box.appendChild(results);
  body.appendChild(box);

  // Several scenarios side by side, like a spreadsheet of what-ifs.
  const cmp = el('div', { class: 'whatif compare' });
  cmp.appendChild(el('h3', {}, 'Compare'));
  const cmpInputs = el('div', { class: 'whatif-inputs' });
  const listField = (label, value, hint) => {
    const lab = el('label', { class: 'field wide' }, label);
    const input = el('input', { type: 'text', inputmode: 'decimal', value, 'aria-describedby': '' });
    lab.append(input, el('span', { class: 'hint' }, hint));
    return [lab, input];
  };
  const [c1, extrasIn] = listField('Extra each month', saved.cmpExtras ?? '200, 250, 300, 350, 400, 500', 'From the “Starting” month above, separated by commas');
  const [c2, lumpsIn] = listField('One-time payments', saved.cmpLumps ?? '10000, 20000', 'In the “In” month above, as chosen above (shorten or recast)');
  cmpInputs.append(c1, c2);
  cmp.appendChild(cmpInputs);
  const cmpTable = el('div', { class: 'table-wrap' });
  cmp.appendChild(cmpTable);
  body.appendChild(cmp);

  const chartCard = el('div', { class: 'chart-card loan-chart' });
  const chart = el('div', { class: 'chart', 'data-label': `${loan.name} balance over time` });
  chartCard.append(el('h3', {}, 'Balance over time'), chart);
  body.appendChild(chartCard);

  const sched = el('details', { class: 'chart-table schedule' });
  const schedSummary = el('summary', {}, 'Amortization schedule');
  const monthlyToggle = el('label', { class: 'inline-check' });
  const monthlyBox = el('input', { type: 'checkbox' });
  monthlyToggle.append(monthlyBox, ' Show every month');
  const schedTable = el('div', { class: 'table-wrap' });
  sched.append(schedSummary, monthlyToggle, schedTable);
  body.appendChild(sched);

  const update = () => {
    const extra = Math.max(0, Number(extraIn.value) || 0), lump = Math.max(0, Number(lumpIn.value) || 0);
    const from = isYm(fromIn.value) ? fromIn.value : nextDue, lumpAt = isYm(lumpAtIn.value) ? lumpAtIn.value : nextDue;
    const recast = modeIn.value === 'recast';
    prefs.set(key, { extra: extraIn.value, from, lump: lumpIn.value, lumpAt, mode: modeIn.value, cmpExtras: extrasIn.value, cmpLumps: lumpsIn.value });
    const run = (x, l) => amortize({ balance: loan.balance, rate: loan.rate.value, payment: loan.payment.value, start: nextDue, extra: x, extraFrom: from, lumps: [{ month: lumpAt, amount: l }], recast });
    const what = extra || lump ? run(extra, lump) : null;
    const tile = (label, value, note) => { const d = el('div'); d.append(el('span', {}, label), el('strong', {}, value)); if (note) d.append(el('small', { class: 'muted' }, note)); return d; };
    const cut = what ? base.months - what.months : 0;
    const yrs = (mo) => (mo >= 12 ? `${Math.floor(mo / 12)} yr${mo >= 24 ? 's' : ''}${mo % 12 ? ` ${mo % 12} mo` : ''}` : `${mo} mo`);
    results.replaceChildren(
      tile('Paid off', ymLabel((what || base).payoff), what && cut ? `instead of ${ymLabel(base.payoff)}` : `${yrs(base.months)} from now`),
      tile('Months cut', what ? `${cut}` : '0', what && cut ? yrs(cut) + ' sooner' : what ? 'same payoff date: the payment drops instead' : 'add a payment above'),
      tile('Interest saved', money(what ? base.interest - what.interest : 0), what ? `${money(what.interest)} left to pay` : null),
      recast && what && lump ? tile('New payment', `${money(what.payment)}/mo`, `instead of ${money(loan.payment.value)} (principal & interest)`)
        : tile('Interest left to pay', money(base.interest), 'on the current schedule'),
    );
    renderCompare(cmpTable, base, [
      ...parseAmounts(extrasIn.value).map((x) => ({ label: `+${wholeMoney(x)} a month`, sched: run(x, 0), monthly: x })),
      ...parseAmounts(lumpsIn.value).map((x) => ({ label: `${wholeMoney(x)} once${recast ? ', recast' : ''}`, sched: run(0, x) })),
    ]);
    // Balance at the end of each month, both schedules.
    const labels = base.rows.map((r) => ymLabel(r.month));
    const series = [{ label: 'Current schedule', color: 'var(--tick)', dashed: !!what, values: base.rows.map((r) => r.balance) }];
    if (what) series.push({ label: 'With extra payments', color: 'var(--series-1)', values: base.rows.map((_, i) => (i < what.rows.length ? what.rows[i].balance : null)) });
    Charts.lines(chart, { labels, series, format: wholeMoney });
    renderSchedule(schedTable, what || base, monthlyBox.checked, !!what, offset);
  };
  for (const i of [extraIn, fromIn, lumpIn, lumpAtIn, extrasIn, lumpsIn]) i.addEventListener('input', update);
  modeIn.addEventListener('change', update);
  monthlyBox.addEventListener('change', update);
  reset.addEventListener('click', () => { extraIn.value = ''; lumpIn.value = ''; fromIn.value = nextDue; lumpAtIn.value = nextDue; update(); });
  // Charts need the panel's width, so draw once it's on the page.
  requestAnimationFrame(update);
  return panel;
}

const parseAmounts = (text) => [...new Set(String(text).split(/[,\s]+/).map((x) => Number(x.replace(/[$,]/g, ''))).filter((x) => x > 0 && x < 1e8))].slice(0, 12);

// Scenarios against the current schedule. "vs. above" is the extra months
// each step buys over the row before it.
function renderCompare(container, base, scenarios) {
  let prevCut = 0;
  const rows = [{ label: 'Current schedule', sched: base, base: true }, ...scenarios].map((r) => {
    const cut = base.months - r.sched.months;
    const step = r.monthly ? cut - prevCut : null; // only between extra-each-month rows
    if (r.monthly) prevCut = cut;
    return { ...r, cut, step };
  });
  Charts.table(container, {
    rows,
    columns: [
      { label: 'Scenario', get: (r) => r.label },
      { label: 'Total interest', num: true, get: (r) => money(r.sched.interest) },
      { label: 'Interest saved', num: true, get: (r) => (r.base ? '—' : money(base.interest - r.sched.interest)) },
      { label: 'Months saved', num: true, get: (r) => (r.base ? '—' : String(r.cut)) },
      { label: 'vs. row above', num: true, get: (r) => (r.step == null ? '' : `${r.step} mo`) },
      { label: 'Paid off', num: true, get: (r) => ymLabel(r.sched.payoff) },
      { label: 'Monthly payment', num: true, get: (r) => money(r.sched.payment + (r.monthly || 0)) },
    ],
  });
}

// The schedule as a table: one row per year, or every payment.
// offset: payments already made, so # counts from the loan's first payment.
function renderSchedule(container, sched, monthly, withExtra, offset = 0) {
  if (monthly) {
    Charts.table(container, {
      rows: sched.rows,
      columns: [
        { label: '#', num: true, get: (r) => String(r.n + offset) },
        { label: 'Payment date', get: (r) => ymLabel(r.month) },
        { label: 'Starting balance', num: true, get: (r) => money(r.start) },
        { label: 'Principal', num: true, get: (r) => money(r.principal) },
        { label: 'Interest', num: true, get: (r) => money(r.interest) },
        ...(withExtra ? [{ label: 'Extra', num: true, get: (r) => (r.extra ? money(r.extra) : '—') }] : []),
        { label: 'Principal to date', num: true, get: (r) => money(r.principal_to_date) },
        { label: 'Interest to date', num: true, get: (r) => money(r.interest_to_date) },
      ],
    });
    container.querySelector('tbody tr')?.classList.add('next-row');
    return;
  }
  const byYear = new Map();
  for (const r of sched.rows) {
    const y = r.month.slice(0, 4);
    const t = byYear.get(y) || { month: y, start: r.start, payment: 0, principal: 0, extra: 0, interest: 0 };
    t.payment += r.payment; t.principal += r.principal; t.extra += r.extra; t.interest += r.interest;
    t.balance = r.balance; t.principal_to_date = r.principal_to_date; t.interest_to_date = r.interest_to_date;
    byYear.set(y, t);
  }
  Charts.table(container, {
    rows: [...byYear.values()],
    columns: [
      { label: 'Year', get: (r) => r.month },
      { label: 'Starting balance', num: true, get: (r) => money(r.start) },
      { label: 'Principal', num: true, get: (r) => money(r.principal) },
      { label: 'Interest', num: true, get: (r) => money(r.interest) },
      ...(withExtra ? [{ label: 'Extra', num: true, get: (r) => (r.extra ? money(r.extra) : '—') }] : []),
      { label: 'Principal to date', num: true, get: (r) => money(r.principal_to_date) },
      { label: 'Interest to date', num: true, get: (r) => money(r.interest_to_date) },
      { label: 'Balance after', num: true, get: (r) => money(r.balance) },
    ],
  });
}

let editingLoan = null;
const loanForm = $('#loan-form');
function openLoanDialog(loan, { highlight = false } = {}) {
  editingLoan = loan;
  loanForm.reset();
  $('#loan-error').hidden = true;
  $('#loan-title').textContent = loan.name;
  const mine = loan.mine || {};
  const set = (k, v, ph) => { loanForm[k].value = v ?? ''; if (ph !== undefined && loanForm[k].type !== 'date') loanForm[k].placeholder = ph ?? ''; };
  set('rate', mine.rate, loan.rate.source && loan.rate.source !== 'you' ? String(loan.rate.value) : '');
  set('payment', mine.payment, loan.payment.source && loan.payment.source !== 'you' ? String(loan.payment.value) : '');
  set('escrow', mine.escrow, loan.escrow.source && loan.escrow.source !== 'you' ? String(loan.escrow.value) : '');
  set('original_principal', mine.original_principal, loan.original_principal.source === 'bank' ? String(loan.original_principal.value) : '');
  for (const k of ['maturity_date', 'next_due_date', 'origination_date']) set(k, mine[k]);
  $('#loan-dialog').showModal();
  markNeeded(loanForm, highlight ? loan.missing.flatMap((m) => LOAN_FIELDS_FOR[m] || []) : []);
}
loanForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ['rate', 'payment', 'escrow', 'maturity_date', 'next_due_date', 'original_principal', 'origination_date']) body[k] = loanForm[k].value;
  try {
    await api(`/api/loans/${encodeURIComponent(editingLoan.account_id)}`, { method: 'PUT', body });
    $('#loan-dialog').close();
    await loadLoans();
  } catch (err) {
    const box = $('#loan-error');
    box.textContent = err.message;
    box.hidden = false;
  }
});
$('#loan-cancel').addEventListener('click', () => $('#loan-dialog').close());
$('#loan-clear').addEventListener('click', async () => {
  await api(`/api/loans/${encodeURIComponent(editingLoan.account_id)}`, { method: 'PUT', body: {} });
  $('#loan-dialog').close();
  await loadLoans();
});

// ------------------------------------------------------------ Investments --
// Fixed order, so each type always gets the same color.
const INV_TYPES = [
  ['equity', 'Stocks'], ['etf', 'ETFs'], ['mutual fund', 'Mutual funds'], ['fixed income', 'Bonds'],
  ['cash', 'Cash'], ['cryptocurrency', 'Crypto'], ['derivative', 'Options & derivatives'],
];
const invTypeLabel = (t) => INV_TYPES.find(([k]) => k === t)?.[1] || 'Other';
const invTypeColor = (t) => { const i = INV_TYPES.findIndex(([k]) => k === t); return i >= 0 ? `var(--cat-${i + 1})` : 'var(--cat-other)'; };
const INV_STATUS = {
  PRODUCTS_NOT_SUPPORTED: 'doesn’t share investment details through Plaid. Balances still update.',
  INVALID_PRODUCT: 'can’t share investment details yet: turn on the Investments product in your Plaid dashboard. Balances still update.',
  PRODUCT_NOT_READY: 'is still preparing investment details. They’ll appear after the next update.',
};
const gainText = (g, pct) => (g == null ? '—' : `${signedMoney(g)}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}`);

async function loadInvestments() {
  await withLoading($('#view-investments'), async () => {
    const d = await api('/api/investments');
    const notes = $('#inv-status');
    notes.replaceChildren();
    notes.append(...consentNotes(d.status, 'investment details', INV_STATUS));
    $('#inv-value').textContent = money(d.value);
    const gainEl = $('#inv-gain');
    gainEl.textContent = d.cost_basis ? gainText(d.gain, d.gain_pct) : '—';
    gainEl.className = d.cost_basis ? (d.gain >= 0 ? 'pos' : 'neg') : '';
    $('#inv-accounts-count').textContent = String(d.accounts.length);
    $('#inv-holdings-count').textContent = String(d.accounts.reduce((s, a) => s + a.holdings.length, 0));

    const slices = d.allocation.filter((x) => x.value > 0).map((x) => ({ label: invTypeLabel(x.type), value: x.value, color: invTypeColor(x.type) }));
    const allocEl = $('#inv-allocation');
    if (slices.length) Charts.donut(allocEl, { slices, format: wholeMoney, centerLabel: 'invested' });
    else allocEl.replaceChildren(el('p', { class: 'chart-empty muted' }, d.accounts.length ? 'No holdings reported yet.' : 'No investment accounts linked yet. Add one with + Add account.'));
    const allocTotal = slices.reduce((s, x) => s + x.value, 0);
    Charts.table($('#inv-allocation-table'), {
      rows: slices,
      columns: [
        { label: 'Type', get: (x) => x.label },
        { label: 'Value', num: true, get: (x) => money(x.value) },
        { label: 'Share', num: true, get: (x) => `${allocTotal ? Math.round((x.value / allocTotal) * 100) : 0}%` },
      ],
    });

    const box = $('#inv-accounts');
    box.replaceChildren();
    for (const a of d.accounts) {
      const panel = el('div', { class: 'panel' });
      const head = el('div', { class: 'panel-head' });
      const title = el('div');
      title.append(el('h2', {}, a.name), el('p', { class: 'muted subhead' }, a.updated_at ? `Updated ${new Date(a.updated_at).toLocaleString()}` : 'No holdings reported yet'));
      head.append(title, el('strong', { class: 'head-figure' }, a.balance == null ? '—' : money(a.balance)));
      panel.appendChild(head);
      if (a.holdings.length) {
        const wrap = el('div', { class: 'table-wrap' });
        const t = el('table', { class: 'tx-table holdings-table' });
        const hr = el('tr');
        ['Holding', 'Type', 'Shares', 'Price', 'Value', 'Gain / loss'].forEach((h, i) => hr.appendChild(el('th', { class: i >= 2 ? 'num' : '' }, h)));
        t.appendChild(el('thead')).appendChild(hr);
        const body = el('tbody');
        for (const h of a.holdings) {
          const tr = el('tr');
          const name = el('td', { class: 'desc' });
          name.append(el('strong', {}, h.ticker || h.name), ...(h.ticker ? [el('div', { class: 'sub' }, h.name)] : []));
          const pct = h.gain != null && h.cost_basis ? (h.gain / h.cost_basis) * 100 : null;
          tr.append(name, el('td', { class: 'cat' }, invTypeLabel(h.type)),
            el('td', { class: 'num' }, h.quantity == null ? '' : Number(h.quantity).toLocaleString(undefined, { maximumFractionDigits: 6 })),
            el('td', { class: 'num' }, h.price == null ? '' : money(h.price)),
            el('td', { class: 'num' }, h.value == null ? '' : money(h.value)),
            el('td', { class: `num ${!h.gain ? 'muted' : h.gain > 0 ? 'pos' : 'neg'}` }, gainText(h.gain, pct)));
          body.appendChild(tr);
        }
        t.appendChild(body);
        wrap.appendChild(t);
        panel.appendChild(wrap);
      }
      box.appendChild(panel);
    }
  });
}

// ----------------------------------------------------------------- Router --
const VIEWS = { overview: loadOverview, transactions: loadTransactions, bills: loadBills, cards: loadCards, loans: loadLoans, budgets: loadBudgets, trends: loadTrends, investments: loadInvestments, rules: loadRulesView };

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
  if (state.view === 'overview' && cache.overview) {
    renderOverviewNet(cache.overview.insights.months);
    renderPace(cache.overview.pace);
  }
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
  if (e.target.closest('a[target=_blank]')) return; // login link: just open it
  const csv = e.target.closest('[data-csv]');
  if (csv) { openCsvDialog(csv.dataset.csv); return; }
  const rename = e.target.closest('[data-rename]');
  if (rename) {
    e.stopPropagation();
    const a = state.accounts.find((x) => x.account_id === rename.dataset.rename);
    if (a?.manual) { openManualDialog(a); return; }
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
