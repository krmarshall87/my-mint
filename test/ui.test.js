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
  // Interest shows what skipping the bill would cost, next to what the plan leaves.
  await page.goto(`${api.base}/#cards`);
  await page.waitForTimeout(800);
  assert.match(await page.locator('#card-plan-table').innerText(), /~\$[\d,.]+ if not paid[\s\S]*with this plan/);
  // Every summary number explains itself: tapping (i) shows what it means.
  assert.equal(await page.locator('#view-cards .summary .info-btn').count(), 8);
  await page.locator('#cp-income').locator('xpath=..').locator('.info-btn').click();
  assert.match(await page.locator('#view-cards .info-tip.open .tip').innerText(), /next deposit the plan expects/);
  assert.match(await page.locator('#cp-interest').locator('xpath=..').innerText(), /Interest this month/);
  // "I paid this": the statement balance is preselected, and saving shows it on the card with an Undo.
  await page.locator('#card-plan-table tr', { hasText: 'Citi Double Cash' }).getByRole('button', { name: /I paid/ }).click();
  await page.waitForSelector('#paid-dialog[open]');
  assert.equal(await page.locator('#paid-form input[name=kind]:checked').getAttribute('value'), 'statement');
  await page.locator('#paid-form input[value=custom]').check();
  await page.locator('#paid-form input[name=amount]').fill('250');
  await page.locator('#paid-form button[type=submit]').click();
  await page.waitForSelector('#paid-dialog', { state: 'hidden' });
  await page.waitForTimeout(800);
  const citiRow = page.locator('#card-plan-table tr', { hasText: 'Citi Double Cash' });
  assert.match(await citiRow.innerText(), /You paid \$250\.00/);
  assert.match(await page.locator('#cp-checking-note').innerText(), /\$250\.00 you marked paid/);
  await citiRow.getByRole('button', { name: /Remove the/ }).click();
  await page.waitForTimeout(800);
  assert.doesNotMatch(await page.locator('#card-plan-table').innerText(), /You paid/);
  // A card you marked paid stays on the page, under "Paid this cycle", with its Undo.
  await page.locator('#card-plan-table tr', { hasText: 'Chase Freedom' }).getByRole('button', { name: /I paid/ }).click();
  await page.waitForSelector('#paid-dialog[open]');
  await page.locator('#paid-form button[type=submit]').click();
  await page.waitForSelector('#paid-dialog', { state: 'hidden' });
  await page.waitForTimeout(800);
  assert.match(await page.locator('#card-plan-table').innerText(), /PAID THIS CYCLE[\s\S]*Chase Freedom/i);
  await page.locator('#card-plan-table tr', { hasText: 'Chase Freedom' }).getByRole('button', { name: /Remove the/ }).click();
  await page.waitForTimeout(800);
  // "Apply rewards": just an amount, and the card shows it as rewards.
  await page.locator('#card-plan-table tr', { hasText: 'Citi Double Cash' }).getByRole('button', { name: /Apply rewards/ }).click();
  await page.waitForSelector('#paid-dialog[open]');
  assert.equal(await page.locator('#paid-choices').isVisible(), false);
  await page.locator('#paid-form input[name=amount]').fill('40');
  await page.locator('#paid-form button[type=submit]').click();
  await page.waitForSelector('#paid-dialog', { state: 'hidden' });
  await page.waitForTimeout(800);
  assert.match(await page.locator('#card-plan-table tr', { hasText: 'Citi Double Cash' }).innerText(), /Rewards: \$40\.00 applied/);
  // The plan pays the statement less the rewards, and the statement line says so.
  const citiText = await page.locator('#card-plan-table tr', { hasText: 'Citi Double Cash' }).innerText();
  assert.match(citiText, /− \$40\.00 rewards/);
  // A card missing its statement: filling either closing field clears "Needed" on both.
  await page.locator('#card-plan-table tr', { hasText: 'OnePay' }).getByRole('button', { name: /Add details/ }).click();
  await page.waitForSelector('#card-dialog[open]');
  assert.ok(await page.locator('#card-form .field.needed input[name=closing_day]').count());
  await page.locator('#card-form input[name=closing_day]').fill('7');
  assert.equal(await page.locator('#card-form .field.needed input[name=closing_day], #card-form .field.needed input[name=close_days_before_due]').count(), 0);
  await page.locator('#card-cancel').click();
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
