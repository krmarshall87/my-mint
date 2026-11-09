// Every tab in a real browser, on stubbed data: no script errors, and nothing
// rendered as "[object …]" or "undefined". Needs Playwright with a browser;
// skipped where there isn't one (it isn't a dependency).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, linkBank, PASSWORD } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

const VIEWS = ['overview', 'transactions', 'bills', 'cards', 'loans', 'budgets', 'trends', 'investments', 'rules'];

test('every tab renders cleanly', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  // Short on cash, so the card plan shows its warnings and "no money" lines too.
  const api = await startServer({ STUB_CASH: '200' });
  t.after(() => api.stop());
  await linkBank(api);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`no browser: ${err.message.split('\n')[0]}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ httpCredentials: { username: 'me', password: PASSWORD } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const view of VIEWS) {
    await page.goto(`${api.base}/#${view}`);
    await page.waitForFunction((v) => {
      const s = document.querySelector(`#view-${v}`);
      return s && !s.hidden && !s.classList.contains('loading');
    }, view, { timeout: 10000 });
    await page.waitForTimeout(300);
    const text = await page.locator(`#view-${view}`).innerText();
    assert.doesNotMatch(text, /\[object [A-Za-z]+\]/, `${view} shows an [object …]`);
    assert.doesNotMatch(text, /\bundefined\b|\bNaN\b/, `${view} shows undefined or NaN`);
  }
  // The car loan has no rate yet: its note must read as text.
  await page.goto(`${api.base}/#loans`);
  await page.waitForTimeout(800);
  assert.match(await page.locator('.loan', { hasText: 'Auto Loan' }).innerText(), /Add the interest rate to see the payoff schedule/);
  assert.doesNotMatch(await page.locator('#view-loans').innerText(), /\b0 months? (ahead|behind)/, 'never "0 months behind"');
  // The mortgage knows where it stands on its original schedule.
  assert.match(await page.locator('.loan', { hasText: 'Home Mortgage' }).innerText(), /#\d+ of 360[\s\S]*(On schedule|months? (ahead|behind))/);
  // The alert's "Add it" opens that loan's dialog with the rate marked as needed.
  await page.goto(`${api.base}/#overview`);
  await page.waitForTimeout(1200);
  await page.locator('#alerts li', { hasText: 'Auto Loan' }).getByRole('button', { name: 'Add it' }).click();
  await page.waitForSelector('#loan-dialog[open]', { timeout: 5000 });
  assert.equal(await page.locator('#loan-dialog .field.needed input[name=rate]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'rate');
  assert.equal(await page.evaluate(() => location.hash), '#loans');
  assert.deepEqual(errors, []);
});
