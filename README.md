# My Mint

A small personal app that links your bank accounts through [Plaid](https://plaid.com) and shows all of their transactions in one place. You can search, filter by account, category and date, and export to CSV. Charts show cash flow by month, spending by category and top merchants; they follow the same filters. Click a category or merchant to filter by it.

- **Backend:** Node + Express, using the official `plaid` SDK. It calls `/link/token/create`, `/item/public_token/exchange` and `/transactions/sync`.
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
4. To use real accounts, change `PLAID_ENV` to `production` and use your production secret.

### OAuth banks (Chase, Bank of America, Wells Fargo, Capital One, …)

Many large US banks link through OAuth, which redirects back to your app. To support them:

1. In the Plaid dashboard, go to **Developers → API → Allowed redirect URIs** and add `https://<your-service>.onrender.com/`.
2. Set `PLAID_REDIRECT_URI` to exactly the same value.

### Notes

- **Production access:** you need Plaid production approval for the Transactions product. Some institutions also need extra OAuth registration in the dashboard; it can take a few days.
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
| GET | `/api/insights` | Totals, income and spending by month, spending by category and top merchants. Same filters as `/api/transactions`; transfers between your own accounts and credit-card payments are excluded. |
| GET | `/api/transactions` | Filters: `q`, `account_id`, `category`, `start`, `end`, `limit`, `offset` |
