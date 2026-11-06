const PAGE_SIZE = 100;
const state = { offset: 0, total: 0, accounts: [], items: [] };
const $ = (sel) => document.querySelector(sel);
const filtersForm = $('#filters');

const money = (n, cur = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const prettyCat = (c) => (c ? c.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()) : '');

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

// --------------------------------------------------------------- Render --
function renderAccounts() {
  const list = $('#accounts');
  const selected = filtersForm.account_id.value;
  $('#no-accounts').hidden = state.items.length > 0;
  list.innerHTML = state.items
    .map((item) => {
      const accts = state.accounts.filter((a) => a.item_id === item.item_id);
      return `<li class="inst">
        <div class="inst-head">
          <strong>${esc(item.institution_name)}</strong>
          <button class="link" data-remove="${esc(item.item_id)}">remove</button>
        </div>
        ${item.error ? `<div class="inst-error">${esc(item.error)} — <button class="link" data-relink="${esc(item.item_id)}">reconnect</button></div>` : ''}
        ${accts
          .map(
            (a) => `<div class="acct ${a.account_id === selected ? 'active' : ''}" data-account="${esc(a.account_id)}">
              <span>${esc(a.name)}<small>${esc(a.subtype || a.type)}${a.mask ? ` ••${esc(a.mask)}` : ''}</small></span>
              <span class="num">${a.current_balance == null ? '' : money(a.current_balance, a.iso_currency_code)}</span>
            </div>`,
          )
          .join('')}
      </li>`;
    })
    .join('');

  const sel = filtersForm.account_id;
  sel.innerHTML =
    '<option value="">All accounts</option>' +
    state.accounts
      .map((a) => `<option value="${esc(a.account_id)}">${esc(a.institution_name)} · ${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ''}</option>`)
      .join('');
  sel.value = selected;
}

async function loadCategories() {
  const cats = await api('/api/categories');
  const sel = filtersForm.category;
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(prettyCat(c))}</option>`).join('');
  sel.value = current;
}

function currentQuery(extra = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(filtersForm)) if (v) params.set(k, v);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params;
}

async function loadTransactions() {
  const data = await api(`/api/transactions?${currentQuery({ limit: PAGE_SIZE, offset: state.offset })}`);
  state.total = data.total;
  const acctById = Object.fromEntries(state.accounts.map((a) => [a.account_id, a]));

  $('#sum-count').textContent = data.total.toLocaleString();
  $('#sum-in').textContent = money(data.inflow);
  $('#sum-out').textContent = money(data.outflow);
  const net = data.inflow - data.outflow;
  const netEl = $('#sum-net');
  netEl.textContent = money(net);
  netEl.className = net >= 0 ? 'pos' : 'neg';

  $('#tx-body').innerHTML = data.transactions.length
    ? data.transactions
        .map((t) => {
          const a = acctById[t.account_id];
          // Plaid: positive amount = money leaving the account.
          const out = t.amount > 0;
          return `<tr>
            <td>${esc(t.date)}</td>
            <td class="desc">
              ${t.logo_url ? `<img class="logo" src="${esc(t.logo_url)}" alt="" loading="lazy" />` : ''}
              ${esc(t.merchant_name || t.name)}${t.pending ? '<span class="badge">pending</span>' : ''}
              ${t.merchant_name && t.merchant_name !== t.name ? `<div class="sub">${esc(t.name)}</div>` : ''}
            </td>
            <td>${esc(prettyCat(t.category))}</td>
            <td>${a ? `${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ''}` : ''}</td>
            <td class="num ${out ? 'neg' : 'pos'}">${out ? '−' : '+'}${money(Math.abs(t.amount), t.iso_currency_code)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="5" class="empty">${state.items.length ? 'No transactions match these filters.' : 'Link an account to see transactions.'}</td></tr>`;

  const from = data.total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + PAGE_SIZE, data.total);
  $('#page-info').textContent = `${from}–${to} of ${data.total.toLocaleString()}`;
  $('#prev-btn').disabled = state.offset === 0;
  $('#next-btn').disabled = to >= data.total;
}

async function refreshAll() {
  [state.items, state.accounts] = await Promise.all([api('/api/items'), api('/api/accounts')]);
  renderAccounts();
  await loadCategories();
  await loadTransactions();
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
    rows.push([t.date, t.name, t.merchant_name || '', prettyCat(t.category), a ? `${a.institution_name} ${a.name}` : '', -t.amount, t.iso_currency_code || '', t.pending]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// --------------------------------------------------------------- Events --
let debounce;
filtersForm.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.offset = 0;
    renderAccounts();
    loadTransactions();
  }, 250);
});
filtersForm.addEventListener('submit', (e) => e.preventDefault());
$('#link-btn').addEventListener('click', () => startLink());
$('#sync-btn').addEventListener('click', sync);
$('#export-btn').addEventListener('click', () => exportCsv().catch((e) => alert(e.message)));
$('#prev-btn').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadTransactions(); });
$('#next-btn').addEventListener('click', () => { state.offset += PAGE_SIZE; loadTransactions(); });

$('#accounts').addEventListener('click', async (e) => {
  const acct = e.target.closest('[data-account]');
  const remove = e.target.closest('[data-remove]');
  const relink = e.target.closest('[data-relink]');
  if (remove) {
    if (!confirm('Disconnect this institution and delete its stored transactions?')) return;
    await api(`/api/items/${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' });
    filtersForm.account_id.value = '';
    await refreshAll();
  } else if (relink) {
    startLink(relink.dataset.relink);
  } else if (acct) {
    const sel = filtersForm.account_id;
    sel.value = sel.value === acct.dataset.account ? '' : acct.dataset.account;
    state.offset = 0;
    renderAccounts();
    loadTransactions();
  }
});

// ----------------------------------------------------------------- Boot --
(async function boot() {
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
