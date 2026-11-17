// Statement cycles, checked against the owner's OnePay statements: they close
// 23 days before the due date (the 5th), a weekend moved back to Friday.
const test = require('node:test');
const assert = require('node:assert/strict');
const { statementCycle, closeBeforeDue } = require('../cycle');

const onepay = { close_days_before_due: 23, due_day: 5 };

test('OnePay closes 23 days before the 5th, on the Friday before a weekend', () => {
  // Statement dates from the card's website, Jul–Nov 2026.
  assert.equal(closeBeforeDue('2026-08-05', 23), '2026-07-13');
  assert.equal(closeBeforeDue('2026-09-05', 23), '2026-08-13');
  assert.equal(closeBeforeDue('2026-10-05', 23), '2026-09-11'); // Sep 12 is a Saturday
  assert.equal(closeBeforeDue('2026-11-05', 23), '2026-10-13');
  assert.equal(closeBeforeDue('2026-12-05', 23), '2026-11-12');
  assert.equal(closeBeforeDue('2026-03-01', 1), '2026-02-27'); // a Sunday close moves back two days
});

test('the cycle is the latest statement that has closed', () => {
  assert.deepEqual(statementCycle(onepay, '2026-11-17'), { statement_date: '2026-11-12', due_date: '2026-12-05' });
  assert.deepEqual(statementCycle(onepay, '2026-11-12'), { statement_date: '2026-11-12', due_date: '2026-12-05' }, 'closes today');
  assert.deepEqual(statementCycle(onepay, '2026-11-11'), { statement_date: '2026-10-13', due_date: '2026-11-05' });
  assert.deepEqual(statementCycle(onepay, '2026-09-12'), { statement_date: '2026-09-11', due_date: '2026-10-05' });
  assert.deepEqual(statementCycle(onepay, '2026-12-31'), { statement_date: '2026-12-11', due_date: '2027-01-05' }, 'across the year');
});

test('a fixed closing day still works, and a cycle needs its due day', () => {
  assert.deepEqual(statementCycle({ closing_day: 1, due_day: 28 }, '2026-11-17'), { statement_date: '2026-11-01', due_date: '2026-11-28' });
  assert.deepEqual(statementCycle({ closing_day: 31, due_day: 25 }, '2026-03-15'), { statement_date: '2026-02-28', due_date: '2026-03-25' });
  assert.equal(statementCycle({ close_days_before_due: 23 }, '2026-11-17'), null);
  assert.equal(statementCycle({ due_day: 5 }, '2026-11-17'), null);
});
