# My Mint

A small personal app that links your bank accounts through [Plaid](https://plaid.com) and shows all of their transactions in one place. You can search, filter by account, category and date, and export to CSV.

- **Backend:** Node + Express, using the official `plaid` SDK. It calls `/link/token/create`, `/item/public_token/exchange` and `/transactions/sync`.
- **Storage:** Postgres when `DATABASE_URL` is set. Without it, data goes to a local JSON file (`data/store.json`) for development.
- **Auth:** HTTP Basic Auth on every page and API route. The username can be anything; the password is `APP_PASSWORD`.

Transactions are pulled incrementally with `/transactions/sync`: each linked institution keeps a cursor, and only changes since the last sync are fetched. A sync runs when the page loads and when you click **Refresh**. When you first link an account, up to 24 months of history is requested.

## Run locally

```bash
cp .env.example .env    # fill in PLAID_CLIENT_ID / PLAID_SECRET
npm install
npm run dev             # http://localhost:3000
```

With `PLAID_ENV=sandbox`, link any bank in Plaid Link and sign in with `user_good` / `pass_good`.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, go to **New → Blueprint** and pick this repo. `render.yaml` creates:
   - a Node web service (`my-mint`)
   - a Postgres database (`my-mint-db`), with `DATABASE_URL` wired in automatically
3. When prompted, fill in the secret env vars:
   - `PLAID_CLIENT_ID`, `PLAID_SECRET`: from the Plaid dashboard → Developers → Keys. Use the secret that matches `PLAID_ENV`.
   - `APP_PASSWORD`: a strong password. The app refuses to start in production without it.
   - `PLAID_REDIRECT_URI`: `https://<your-service>.onrender.com/` (see OAuth below).
4. To use real accounts, change `PLAID_ENV` to `production` and use your production secret.

### OAuth banks (Chase, Bank of America, Wells Fargo, Capital One, …)

Many large US banks link through OAuth, which redirects back to your app. To support them:

1. In the Plaid dashboard, go to **Developers → API → Allowed redirect URIs** and add `https://<your-service>.onrender.com/`.
2. Set `PLAID_REDIRECT_URI` to exactly the same value.

### Notes

- **Production access:** you need Plaid production approval for the Transactions product. Some institutions also need extra OAuth registration in the dashboard; it can take a few days.
- **Database plan:** the blueprint uses Render's `basic-256mb` Postgres plan. Free Render Postgres databases expire after 30 days, so they're a poor fit for long-lived data.
- **Security:** access tokens are stored in Postgres, which is reachable only on Render's private network (`ipAllowList: []`). Never commit `.env`.

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
| GET | `/api/transactions` | Filters: `q`, `account_id`, `category`, `start`, `end`, `limit`, `offset` |
