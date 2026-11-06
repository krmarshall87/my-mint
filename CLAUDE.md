# CLAUDE.md

My Mint is a personal app: Plaid-linked bank accounts and their transactions in one view. Node 20+ and Express (`server.js`), with storage in `db.js` (CockroachDB Cloud in production, via the Postgres driver, when `DATABASE_URL` is set; otherwise a JSON file at `data/store.json`). The frontend in `public/` is plain HTML, CSS and JS with no build step. It is deployed on Render through the `render.yaml` Blueprint, which auto-deploys from `master`.

## Workflow

- **Always merge your own PRs.** Branch, push, open the PR, and once your checks pass, mark it ready and merge it into `master`. You don't need to ask first. Merging deploys to Render.
- Before pushing, run `node --check server.js db.js public/app.js`. If you changed `db.js`, also exercise both stores (the JSON file and a local Postgres). Keep SQL portable between Postgres and CockroachDB: no `to_char`, no advisory locks, one DDL statement per query, wrap `count()`/INT8 results in `Number()` (node-pg returns them as strings), and retry transactions on SQLSTATE `40001`.
- Test anything that touches Plaid against the **sandbox** (`PLAID_ENV=sandbox`). To link the test bank without the UI, call `sandboxPublicTokenCreate` (`ins_109508`, First Platypus Bank, `initial_products: ['transactions']`), then POST to `/api/exchange`. Test the Link pop-up itself with Playwright using `user_good` / `pass_good`.
- Never commit secrets: no Plaid keys, `.env`, `data/`, or access tokens. Pass keys as environment variables only.

## Data

- `budgets` table: one row per category (`INCOME` = expected monthly income). Both stores implement `listBudgets`, `setBudget` and `deleteBudget`.

## Plaid conventions

- In Plaid amounts, **positive means money leaving the account**. The UI shows positive amounts as outflow (−) and negative ones as inflow (+). Keep that convention everywhere, including CSV export.
- Sync with `/transactions/sync`, keeping one cursor per Item. Apply each batch (added, modified, removed, cursor) in a single transaction so a partial failure never moves the cursor forward. If you get `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, restart from the original cursor.
- An empty `next_cursor` with no transactions added means Plaid is still preparing the history. Report it as `pending_initial_pull`; it is not an error.
- Access tokens are encrypted at rest (`enc:v1:` prefix, AES-256-GCM, using `ENCRYPTION_KEY`). Always go through the `items.*` helpers in `server.js`, not `store.*Item` directly. Never log an access token or return one from an API. **`ENCRYPTION_KEY` must never change**, or every saved connection becomes unreadable.
- Sandbox and production Items don't mix. Tokens are tied to one environment.

## Architecture rules

- **Run one instance only.** The password-lockout map, the `syncInFlight` lock and the background `setInterval` sync all live in process memory. Running more than one Render instance would split the lockout and run overlapping syncs. To scale out, first move these into the database (for example, a lease row for the sync lock and a table for login failures; CockroachDB has no advisory locks).
- **Start up fast.** Render fails a deploy if the port isn't bound in time. `server.js` calls `app.listen` first, then sets up the schema in the background with retries; `/api` returns 503 until it's ready. Keep it that way.
- **Configuration comes from environment variables, read at use time.** `.env` and Render env vars hold only bootstrap settings and secrets. Don't freeze values that change at runtime into module-level constants. Add a config table only if settings need to change without a redeploy.
- **Retry only idempotent calls.** Transient network failures to Plaid or Postgres can be retried with exponential backoff on reads and on `/transactions/sync` (it's cursor-based, so retrying is safe). Never auto-retry `/item/public_token/exchange` or other one-shot writes.
- **Prefer keyset pagination for new list endpoints** (`WHERE (date, transaction_id) < ($1, $2) ORDER BY date DESC, transaction_id`). Offset paging can skip or repeat rows when a sync lands mid-browse. `/api/transactions` still uses offset paging, which is acceptable for a single user.

## Security

- **Every route except `/healthz` requires auth, reads included.** This is private financial data, so nothing is public.
- Keep the CSP strict. Plaid Link needs `script-src` and `frame-src https://cdn.plaid.com` and inline styles. Load nothing else from third parties.
- Escape all server data before putting it into `innerHTML` (use `esc()` in `app.js`).

## Frontend

- Use the `api()` helper in `public/app.js` for every request. It throws on 4xx/5xx with the server's `error_message`; don't call `fetch` directly.
- On mobile, use `minmax(0, 1fr)` (or `min-width: 0` on grid children) instead of a bare `1fr` next to `white-space: nowrap` content. Keep tables inside a horizontally scrolling wrapper (`.table-wrap`), and set `-webkit-text-size-adjust: 100%`.
- Support both light and dark mode through the CSS variables in `:root`.
- Charts live in `public/charts.js`: plain SVG and HTML built with DOM calls and `textContent`, with no chart library (the CSP blocks third-party scripts). Series colors are `--series-1` (income, blue) and `--series-2` (spending, orange), validated for color-blind safety and contrast against `--panel` in both modes; re-validate before adding or changing a series color. Every chart has a hover/focus tooltip and a "View as table" twin. Income and spending exclude transfers between your own accounts and credit-card payments (`isInternalMove` in `server.js`). Income is only Plaid's `INCOME` category; any other money in is a refund and reduces spending in its own category (`aggregate()` in `server.js`).
- Category colors follow the category, never its rank in the current view: the top 7 spending categories of all time own `--cat-1`…`--cat-7` and the rest fold into `--cat-other` (`categorySlots()` in `server.js`). That 8-color set is validated for color-blind safety in both modes. Three light-mode slots are below 3:1 contrast, so the donut must keep its legend with names and values, and its table view.
- Budget and alert status colors (`--good`, `--warning`, `--critical`) are reserved for status and always ship with a label ("$9 over") or an icon, never color alone.
- The look is Mint-inspired but our own: no Intuit or Mint logos, artwork or copied assets.
- Alerts are computed on each request from the data (`/api/alerts`), so there's no alert state to sync. Dismissals are per-browser (`localStorage`).
