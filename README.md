# My Mint

A small personal finance app that links your bank accounts through [Plaid](https://plaid.com), in the spirit of the old Mint:

- **Overview:** accounts grouped into cash, credit cards, loans and investments, with balances and net worth. Alerts for budget overages, unusual spending, large purchases and income. This month's budgets as progress bars, a 12-month cash-flow chart, and recent transactions.
- **Transactions:** search and filter by account, category and period; export to CSV. Click a category to fix it for one transaction, or save it as a rule.
- **Categories:** Mint's category tree (Auto & Transport › Gas & Fuel, Food & Dining › Groceries, …). Plaid's detailed categories are mapped onto it, so a supermarket lands in Groceries and a café in Coffee Shops. When Plaid has no category, the app uses what that merchant usually is in your history, then a few built-in defaults; guesses are shown in italics.
- **Current spend:** this month's spending so far, day by day, against last month, and how far ahead or behind you are at this point in the month (Overview).
- **Net income and net worth over time:** income above zero, spending below, with the net as a line; and assets vs. debts with net worth (Trends). Balances are saved daily; earlier months are estimated from your transactions and marked as such.
- **Bills:** recurring bills and subscriptions found automatically from your history (mortgage, loans, utilities, insurance, streaming, …) with how often, the typical amount, monthly cost, last paid and next due date. Overview shows what's due in the next 30 days, and alerts remind you 3 days ahead.
- **Rules:** Mint-style rules on the Rules tab. If the description contains / starts with / is exactly some text (optionally in one account, for an amount or amount range), rename the transaction and/or categorize it. Choose *Hide from Budgets & Trends* to keep a transaction without counting it. Rules apply to past and future transactions, or only new ones. They run top to bottom (first match wins), can be reordered, show a live preview of what they'll match, and can be exported and imported as a file.
- **Manual accounts:** for cards Plaid can't connect (a Verizon Visa, a store card), add a manual account with its login page and import the CSV your card's website lets you download. Columns are guessed and remembered per account, there's a preview, and re-importing an overlapping file never duplicates. The sidebar shows when each was last updated and links to its login page in a new tab; after 30 days without an import, you get a reminder (`MANUAL_STALE_DAYS` to change it).
- **Account names:** generic bank names like "CREDIT CARD" are replaced with the card's official name or "<Bank> Credit Card". Click ✎ next to an account to rename it.
- **Budgets:** monthly limits per category and an expected income, with a month picker, progress bars (green, amber, red) with a "today" marker, and a summary of income, spending and what's left over.
- **Credit Cards:** a payment plan for your cards from checking (all checking accounts together). It uses each card's statement balance, due date, minimum and APR, and counts payments made since the statement. Bills paid from checking (found on the Bills tab) come out first, and a buffer stays in checking ($500 by default, editable). Then come every minimum, then statement balances, highest APR first (a 0% promo last, unless it ends within 45 days). Paychecks found in your history count toward any card due after they arrive. What can't be paid by a due date is paid as soon as a paycheck makes room, with the interest it costs. If checking falls short, it suggests moving money from savings, and from a taxable brokerage account only when card debt is over $25,000 (`CARD_PLAN_INVEST_THRESHOLD`); retirement accounts are never suggested. Click Edit on a card to add what your bank doesn't share (APR, a promo and its end date, or the statement for a manual card).
- **Credit use and interest:** each card's credit limit (from your bank, or yours via Edit) and how much of it you're using, flagged over 30%. Also the interest the bank charged on the last statement, and card interest paid this year (Finance Charges).
- **Loans:** your mortgage and loans with rate, principal & interest, escrow, next due date, payoff date, interest paid this year, PMI and escrow balance. Your bank shares these for mortgages and student loans; for car and personal loans, click Edit to add the rate (the payment comes from your history). There's a full amortization schedule (yearly or monthly) and a balance chart. **What if I pay more?** adds an extra amount every month from a chosen month and/or a one-time payment, and shows the new payoff date, months cut and interest saved.
- **Connection expiry:** some banks give a connection a set lifetime. Within 30 days of its end (`CONSENT_WARN_DAYS`), the bank shows "reconnect" and an alert, so it doesn't quietly stop updating.
- **Investments:** for brokerage and retirement accounts (IRA, 401k, …), the Investments tab shows the total value, gain or loss against cost basis, allocation by type (stocks, ETFs, mutual funds, bonds, cash, …) and each account's holdings. Investment activity appears in Transactions: dividends and interest count as income; buys, sells, contributions and withdrawals don't count as income or spending; fees count as spending.
- **Trends:** spending by category as a pie or bars, net income by month, net worth, and top merchants. These follow the filters, and clicking a slice or bar opens the matching transactions.

Income is the Income categories (Paycheck, Bonus, …) plus Dividend & Cap Gains. Other money in is a refund and reduces spending. Transfers, credit-card payments, investment trades and anything in *Hide from Budgets & Trends* are left out of both. Mortgage and loan payments are bills (Bills & Utilities) and count as spending; the matching activity on the loan account itself is left out automatically so nothing is counted twice.

- **Backend:** Node + Express, using the official `plaid` SDK. It calls `/link/token/create`, `/item/public_token/exchange`, `/transactions/sync` and `/accounts/get`, plus `/investments/holdings/get` and `/investments/transactions/get` for banks with investment accounts, `/liabilities/get` for banks with credit cards or loans, and `/item/get` for when a connection expires.
- **Storage:** CockroachDB (or any Postgres) when `DATABASE_URL` is set. Tables are created automatically on startup. Without it, data goes to a local JSON file (`data/store.json`) for development.
- **Auth:** HTTP Basic Auth on every page and API route. The username can be anything; the password is `APP_PASSWORD`. After 10 wrong passwords, that IP address is locked out for 15 minutes.
- **Security:** Plaid access tokens are encrypted in the database with `ENCRYPTION_KEY` (AES-256-GCM). Strict security headers (CSP, HSTS) and `no-store` caching are set on every response.

Transactions are pulled incrementally with `/transactions/sync`: each linked institution keeps a cursor, and only changes since the last sync are fetched. A sync runs when the page loads, when you click **Refresh**, and in the background every `SYNC_INTERVAL_HOURS` hours (default 6). On Render's free plan the service sleeps after about 15 idle minutes, so background syncs only run while it's awake; opening the page still syncs. When you first link an account, up to 24 months of history is requested.

## Run locally

```bash
cp .env.example .env    # fill in PLAID_CLIENT_ID / PLAID_SECRET
npm install
npm run dev             # http://localhost:3000
```

With `PLAID_ENV=sandbox`, link any bank in Plaid Link and sign in with `user_good` / `pass_good`.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, go to **New → Blueprint** and pick this repo. `render.yaml` creates a Node web service (`my-mint`).
3. When prompted, fill in the secret env vars:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET`: from the Plaid dashboard → Developers → Keys. Use the secret that matches `PLAID_ENV`.
   - `DATABASE_URL`: your CockroachDB connection string, with the real SQL user password and `?sslmode=verify-full`.
   - `APP_PASSWORD`: a strong password. The app refuses to start in production without it.
   - `ENCRYPTION_KEY` is generated automatically. Don't change it later, or saved bank connections can't be decrypted and you'll have to re-link them.
   - `PLAID_REDIRECT_URI`: `https://<your-service>.onrender.com/` (see OAuth below).
4. `render.yaml` sets `PLAID_ENV=production`, so `PLAID_SECRET` must be your **production** secret. Render re-applies `value:` entries on every Blueprint sync, so change the environment in `render.yaml`, not in the dashboard. Use a local `.env` with `PLAID_ENV=sandbox` for testing.

### OAuth banks (Chase, Bank of America, Wells Fargo, Capital One, …)

Many large US banks link through OAuth, which redirects back to your app. To support them:

1. In the Plaid dashboard, go to **Developers → API → Allowed redirect URIs** and add `https://<your-service>.onrender.com/`.
2. Set `PLAID_REDIRECT_URI` to exactly the same value.

### Notes

- **Production access:** you need Plaid production approval for the Transactions product. Holdings need the **Investments** product too (billed per connected bank, and only called for banks with investment accounts). Until it's enabled, investment balances still update and the Investments tab says why holdings are missing. Card statements (statement balance, due date, minimum, APR) need the **Liabilities** product, which works the same way. If a bank asks for your OK to share investment details or card statements, click **reconnect** next to it. Some institutions also need extra OAuth registration in the dashboard; it can take a few days.
- **Database:** the app uses CockroachDB Cloud, which is hosted outside Render. If the database is unreachable at startup, the app still starts, returns 503 from the API, and retries the connection in the background.
- **Security:** never commit `.env` or the `DATABASE_URL` password. If your CockroachDB cluster restricts IPs, allow Render's outbound IPs (Render dashboard → your service → **Connect → Outbound**).
- **Sandbox → production:** when you switch `PLAID_ENV`, remove the sandbox institutions in the UI first. Their tokens don't work in production.
- **Money in/out totals** include transfers between your own accounts and credit-card payments. Filter by category to exclude them.

## API

All routes need Basic Auth.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/link-token` | Create a Link token. Pass `{ item_id }` to re-authenticate an existing connection. |
| POST | `/api/exchange` | Exchange a public token, save the Item, and run the first sync |
| POST | `/api/sync` | Sync every linked Item |
| GET | `/api/items` | List linked institutions |
| DELETE | `/api/items/:id` | Remove an Item from Plaid and delete its stored data |
| GET | `/api/accounts` | List accounts with balances |
| GET | `/api/categories` | List categories that appear in your transactions |
| GET | `/api/budgets` | List budgets (`Income` is the expected monthly income; a parent category covers its subcategories) |
| PUT | `/api/budgets/:category` | Create or update a monthly budget: `{ "amount": 400 }` |
| DELETE | `/api/budgets/:category` | Remove a budget |
| GET | `/api/budget-summary?month=YYYY-MM` | Income, spending per budgeted category, and left over for one month |
| GET | `/api/alerts` | Current alerts, computed from your data (broken connections, budgets, unusual spending, large purchases ≥ `ALERT_LARGE_AMOUNT`, income) |
| PUT | `/api/transactions/:id/category` | `{ "category": "TRAVEL" }` fixes one transaction (`null` resets it); add `"pattern": "amazon"` to make it a rule |
| GET / POST | `/api/rules` | List rules (in order, with how many transactions each applies to), or create one: `{ match_type: "contains"\|"starts"\|"equals", pattern, account_id?, amount_min?, amount_max?, rename_to?, category?, apply_past }` |
| PUT / DELETE | `/api/rules/:id` | Update or delete a rule |
| POST | `/api/rules/order` | `{ "ids": [...] }` sets the order, top first |
| POST | `/api/rules/preview` | What a rule would match, before saving |
| GET | `/api/rules/export` | Download your rules as JSON |
| POST | `/api/rules/import` | Add rules from an export file (`{ rules, dry_run }`); they go below your existing rules, duplicates are skipped |
| GET | `/api/category-tree` | The category tree |
| GET | `/api/recurring?days=30` | Recurring bills, those due within `days`, and monthly totals |
| GET | `/api/spending-pace?month=YYYY-MM` | Cumulative spending by day for the month and the one before |
| GET | `/api/card-plan?buffer=500` | The credit card payment plan: cards with what's owed and the planned payments, bills and paychecks, the checking timeline and suggestions |
| PUT | `/api/cards/:id` | Your details for a card: `{ credit_limit, apr, promo_apr, promo_end, statement_balance, statement_date, due_date, minimum_payment }` (`{}` clears them) |
| GET | `/api/loans` | Loans with the bank's details, yours, and payments seen on the loan account (each value says where it came from) |
| PUT | `/api/loans/:id` | Your details for a loan: `{ rate, payment, escrow, maturity_date, next_due_date, original_principal, origination_date }` (`{}` clears them) |
| GET | `/api/investments` | Investment accounts with holdings, total value, gain or loss, allocation by type, and per-bank status |
| GET | `/api/net-worth` | Month-end assets, debts and net worth (`estimated` before daily snapshots began) |
| POST | `/api/manual-accounts` | Add a manual account: `{ name, institution, type, mask, login_url, balance }` |
| PATCH | `/api/manual-accounts/:id` | Edit it |
| POST | `/api/manual-accounts/:id/import` | Import rows parsed from a CSV: `{ rows: [{ date, description, amount }], column_map, balance }` (amount positive = money out) |
| PATCH | `/api/accounts/:id` | `{ "nickname": "Freedom" }` renames an account (`""` clears it) |
| GET | `/api/insights` | Totals, income and spending by month, spending by category and top merchants. Same filters as `/api/transactions`; transfers between your own accounts and credit-card payments are excluded. |
| GET | `/api/transactions` | Filters: `q`, `account_id`, `category`, `start`, `end`, `limit`, `offset` |
