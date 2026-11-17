// Statement cycles for cards whose bank doesn't share statements: the latest
// statement (closing) date on or before today, and its due date. Dates are
// 'YYYY-MM-DD' strings; all math is on UTC calendar days.
//
// Two ways a card can close:
//   closing_day: the same day every month (a short month uses its last day).
//   close_days_before_due: N days before the due date, moved back to the
//     Friday before when that lands on a weekend (as OnePay does: 23 days
//     before the 5th).

const dayIn = (y, m, d) => new Date(Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday

// The closing date for a due date: N days earlier, a weekend moved back to Friday.
function closeBeforeDue(due, days) {
  const d = addDays(due, -days);
  const w = weekday(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

function statementCycle(us, today) {
  if (!us.due_day || (!us.closing_day && !us.close_days_before_due)) return null;
  const [y, m] = today.split('-').map(Number);
  if (us.close_days_before_due) {
    // The latest due date whose statement has already closed.
    for (let k = 2; k >= -3; k--) {
      const due = dayIn(y, m - 1 + k, us.due_day);
      const close = closeBeforeDue(due, us.close_days_before_due);
      if (close <= today) return { statement_date: close, due_date: due };
    }
    return null;
  }
  let close = dayIn(y, m - 1, us.closing_day);
  if (close > today) close = dayIn(y, m - 2, us.closing_day);
  const [cy, cm] = close.split('-').map(Number);
  let due = dayIn(cy, cm - 1, us.due_day);
  if (due <= close) due = dayIn(cy, cm, us.due_day);
  return { statement_date: close, due_date: due };
}

module.exports = { statementCycle, closeBeforeDue, dayIn };
