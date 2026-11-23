# Inventory Management – Backend API

Node.js + Express REST API for the Inventory Management website. Connects to a
PostgreSQL database hosted on **Supabase**, uses JWT login with bcrypt password
hashing, and enforces role-based permissions on every protected route.

## Features

| Area | What it does |
|---|---|
| Login | Email or username + password, Remember me (30 days), password reset |
| Roles | Owner, Product, Sales, Stock, Purchase and Order managers (permission matrix in `sql/schema.sql`) |
| User management (Owner) | Create users, edit details, change role, reset password, deactivate or reactivate |
| Products | Create, edit, search, filter, deactivate, delete (if no history), product photo upload |
| Categories & suppliers | Full CRUD |
| Stock | Stock levels, low-stock and expiry flags, stock in / out / damaged / expired / adjustment, full stock history |
| Purchases | Create purchase orders, receive into stock, cancel pending purchases |
| Orders | Create orders (stock reserved), move through pending → processing → completed, cancel (stock returned) |
| Sales | Quick sale with payment method, underpayment check |
| Dashboard & analytics | Role-aware summary figures and chart data |
| Reports | Sales, top products, purchases by supplier, stock position, CSV export |
| Common | Notifications (low stock, expiry, order and account alerts), activity history, help and support requests |

## Quick start (local)

Requirements: Node.js 18 or newer, a Supabase project (free tier is fine).

```bash
npm install
cp .env.example .env          # then edit .env (see below)
npm run db:demo               # creates tables, roles, demo users and sample data
npm start                     # API on http://localhost:5000
```

Check it is running: `http://localhost:5000/api/health`

Run the end-to-end API check in a second terminal while the server is running:

```bash
npm test
```

### Environment variables (`.env`)

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase: *Project Settings → Database → Connection string → URI* (use the Session pooler). Replace `[YOUR-PASSWORD]`. |
| `DB_SSL` | yes | `true` for Supabase. `false` only for a local Postgres. |
| `JWT_SECRET` | yes | 16+ random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | no | Default `5000` |
| `CORS_ORIGINS` | yes in production | Comma-separated frontend URLs, e.g. `https://inventory.example.com` |
| `FRONTEND_DIST` | no | Path to the built frontend (`dist`) to serve it from this server |
| `JWT_EXPIRES` / `JWT_REMEMBER_EXPIRES` | no | Defaults `8h` / `30d` |
| `ALERT_SCAN_MINUTES` | no | How often low-stock and expiry checks run. Default `60`. |
| `SUPPORT_EMAIL` | no | Shown on the Help page |

**Never commit `.env`.** The database password lives only in the backend.

### Database setup on Supabase

Either run `npm run db:setup` (it reads `DATABASE_URL`), or paste the contents of
`sql/schema.sql` into the Supabase **SQL Editor** and run it. The script is safe to
run more than once.

Row Level Security is enabled on every table. The backend connects with the
database password, so it is unaffected. This stops anyone holding the public
`anon` key from reading tables such as `users`.

### Demo logins

After `npm run db:demo` (password for all: `Demo@1234`):

| Role | Email |
|---|---|
| Owner | owner@demo.local |
| Product Manager | product@demo.local |
| Sales Manager | sales@demo.local |
| Stock Manager | stock@demo.local |
| Purchase Manager | purchase@demo.local |
| Order Manager | orders@demo.local |

**Change these passwords or delete the accounts before going live.**

## API overview

All routes are under `/api`. Protected routes need `Authorization: Bearer <token>`.
Errors are JSON: `{ "error": "message", "details": [{ "field", "message" }] }`.

| Method | Route | Permission |
|---|---|---|
| POST | `/auth/login` | public (rate-limited) |
| POST | `/auth/logout`, GET `/auth/me`, PUT `/auth/profile`, PUT `/auth/preferences`, POST `/auth/change-password` | logged in |
| POST | `/auth/forgot-password`, POST `/auth/reset-password` | public |
| GET / POST | `/users`, PUT `/users/:id`, PUT `/users/:id/role`, POST `/users/:id/status`, POST `/users/:id/reset-password`, GET `/users/roles` | `users.manage` |
| GET / POST / PUT / DELETE | `/categories`, `/categories/:id` | `categories.read` / `categories.write` |
| GET / POST / PUT / DELETE | `/suppliers`, `/suppliers/:id` | `suppliers.read` / `suppliers.write` |
| GET / POST / PUT / DELETE | `/products`, `/products/:id`, POST `/products/:id/image` | `products.read` / `products.write` |
| GET | `/stock/levels`, `/stock/transactions` | `stock.read` |
| POST | `/stock/movements` | `stock.write` |
| GET / POST | `/purchases`, `/purchases/:id` | `purchases.read` / `purchases.write` |
| POST | `/purchases/:id/receive`, `/purchases/:id/cancel` | `purchases.write` |
| GET / POST | `/orders`, `/orders/:id` | `orders.read` / `orders.write` |
| POST | `/orders/:id/status` | `orders.write` |
| GET / POST | `/sales` | `sales.read` / `sales.write` |
| GET | `/dashboard/summary` | any logged-in user (figures filtered by role) |
| GET | `/reports/sales`, `/reports/top-products`, `/reports/purchases`, `/reports/stock` | matching `*.read` + `reports.view` |
| GET | `/reports/export?type=sales\|orders\|purchases\|stock\|stock_history&from&to` | matching `*.read` |
| GET | `/notifications`, POST `/notifications/:id/read`, POST `/notifications/read-all` | logged in (own only) |
| GET | `/activity` | Owner sees all; others see their own |
| GET | `/help`, POST `/support` | logged in |

Every protected request reloads the user and their role from the database. When the
Owner changes someone's role, the old access stops on their next request.

## Project layout

```
sql/schema.sql            tables, roles, permission matrix, RLS
scripts/setup.js          applies schema, optional demo data
scripts/smoke-test.js     end-to-end API checks (npm test)
src/server.js             Express app, security middleware, error handling, alert timer
src/config.js             reads and validates environment variables
src/db.js                 PostgreSQL pool and transaction helper
src/middleware/auth.js    JWT check, permission checks
src/routes/               one file per module
src/services/             stock changes, order creation, activity log, notifications
src/utils/helpers.js      validation, paging, CSV helpers
```

## Deploying

The API runs anywhere Node.js runs (Render, Railway, AWS, a VPS).

1. Set the environment variables above, with `NODE_ENV=production`.
2. Start command: `npm start`. Health check: `/api/health`.
3. Set `CORS_ORIGINS` to your frontend URL, or set `FRONTEND_DIST` to serve the built frontend from the same server.
4. Uploaded product photos are stored in `uploads/` on the server's disk. Free hosts reset this disk on restart, so use persistent storage or Supabase Storage for production.
5. Password-reset tokens are printed to the server log. Connect an email provider (for example Resend or SendGrid) in `src/routes/auth.js` before going live.

## Security notes

- Passwords are hashed with bcrypt. Passwords must be 8+ characters with a letter and a number.
- Login is rate-limited (30 attempts per 15 minutes per IP).
- Helmet sets security headers. CORS is limited to the configured origins.
- Input is validated with zod on every write. SQL uses parameters throughout.
- Stock changes run in database transactions with row locks, so two sales cannot oversell the same item.
- Deactivated accounts are refused on their next request, even with a valid token.
- CSV exports neutralise spreadsheet formula injection.
