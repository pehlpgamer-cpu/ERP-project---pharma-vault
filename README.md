# Pharma Vault

A pharmacy point of sale built on the XianFire stack: Express 4, the Xian view engine (Handlebars,
Tailwind v4 from a CDN), Drizzle ORM and MySQL. Cashiers open a register, ring up over-the-counter
sales at the POS (stock leaves the shelf first-expiry-first-out), and close the drawer at the end of
the day. Managers and accountants read the sales on a dashboard, in a list and through a JSON API.

## What is in it

| Page | Who | What it does |
| --- | --- | --- |
| `/login-page`, `/register-page` | everyone | Sign in; create an account (it has no access until an administrator gives it a role) |
| `/dashboard-page` | `dashboard.view` | Today's and 14-day figures, a daily sales chart with a table view, payment mix, latest sales |
| `/sales`, `/sales/:id` | any `sales.view.*` | Filterable sales list and a printable receipt with the batches each line came from |
| `/pos-page` | `sales.create` | Product search or barcode scan, cart, split payments with live change |
| `/cash-register-page` | `register.manage` | Open a register with a counted float; close it against a counted drawer |
| `/products` | `products.manage` | Product list, create and edit with units, conversion factors, barcodes and selling prices; activate or deactivate. A product with stock or sales keeps its existing units, factors and base unit. |
| `/inventory` | `inventory.view` | Stock per product: on hand, what the branch may sell today, reorder level, and low-stock, expiring (30 days) and expired-stock alerts. Users with the all-branch scope (`sales.view.all`) can pick a branch. |
| `/inventory/batches` | `inventory.view` | Batches soonest-expiry first, filtered by status, expiry window or text. With `inventory.manage`: quarantine, release, recall and write off stock in your own branch, each with a reason; other branches are view only. |
| `/suppliers` | `purchasing.view` | Supplier list; with `purchasing.manage` add, edit and deactivate suppliers |
| `/stock-counts` | `inventory.view` | Stock counts in your branch (all branches with `sales.view.all`), filtered by status. With `inventory.adjust`: draft a count of batches (the books' quantity is snapshotted), submit or cancel it; with `inventory.approve`: approve (never your own count), reject or post, which sets each batch to the counted quantity and writes `STOCK_ADJUSTMENT` movements. A post is refused if a batch moved since the count. |
| `/purchase-orders` | `purchasing.view` | Purchase orders in your branch (all branches with `sales.view.all`), filtered by status. With `purchasing.manage`: write and edit drafts, submit, send, cancel and close; with `purchasing.approve`: approve or return; with `inventory.receive`: post goods receipts. |
| `/users` | `users.manage` | List of accounts |

Prescriptions, returns and stock transfers have tables in the database but no
screens yet.

## Requirements

- Node.js 24 or newer
- MySQL 8.4

## Setup

```bash
npm ci
cp .env.example .env        # then point MYSQL_HOST, MYSQL_PORT and the credentials at your database
```

Create the empty database once (the name must match `MYSQL_DATABASE`), then:

```bash
npm run db:push             # creates the tables and views
npm run db:seed             # demo data: two branches, a catalog, accounts and 30 days of sales
npm start                   # http://localhost:3000
```

`npm run xian` runs the same server under nodemon. `db:seed` refuses to run in production or on a
database that already has branches. It seeds everything through the application's own services, so
the history it creates has the stock, cash ledger and invoice numbers the app itself would produce.

### Demo accounts

| Email | Role |
| --- | --- |
| `admin@pharmavault.test` | admin |
| `pharmacist@pharmavault.test` | pharmacist (MAIN) |
| `cashier.main@pharmavault.test` | cashier (MAIN, keeps today's register open) |
| `accountant@pharmavault.test` | accountant |
| `cashier.north@pharmavault.test` | cashier (NORTH) |

Every account uses the password in `SEED_PASSWORD` (at least 14 characters). The default in
`.env.example` is `PharmaVault-demo-2026`. These accounts are for development only.

## Tests

The tests run against a separate database whose name must end in `_test`; the harness refuses to
touch anything else.

```bash
cp .env.test.example .env.test      # create the database and grant access as described inside
npm run db:push:test
npm test                            # everything
npm test -- --files=checkout        # one spec file, matched by the end of its name
```

Other checks:

```bash
npm run lint            # oxlint
npx oxfmt --check <files>
npm run views:check     # every page, layout, partial and helper resolves; render calls pass pageTitle
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_TIMEZONE` | `Asia/Manila` | Business time zone for "today", date filters and daily totals. Data is stored in UTC. A fixed offset is used, so zones with daylight saving time are not supported. |
| `EXPIRY_BUFFER_DAYS` | `0` | A batch is sellable through its printed expiry date minus this many days. |
| `REGISTER_VARIANCE_THRESHOLD` | `50.00` | A drawer count this far over or short needs a note and leaves the session waiting for reconciliation. |
| `SESSION_COOKIE_SECURE` | on in production | Set `false` to serve production over plain HTTP. |
| `TRUST_PROXY` | unset | Number of reverse proxies in front of the app. |
| `SEED_PASSWORD` | `PharmaVault-demo-2026` | Password of every demo account. |

## Permissions

| Permission | admin | pharmacist | cashier | accountant |
| --- | :-: | :-: | :-: | :-: |
| `dashboard.view` | yes | yes | yes | yes |
| `sales.view.own` | yes | | yes | |
| `sales.view.branch` | yes | yes | | |
| `sales.view.all` | yes | | | yes |
| `sales.create` | yes | yes | yes | |
| `register.manage` | yes | yes | yes | |
| `users.manage` | yes | | | |
| `products.manage` | yes | yes | | |
| `inventory.view` | yes | yes | | yes |
| `inventory.manage` | yes | yes | | |
| `inventory.receive` | yes | yes | | |
| `inventory.adjust` | yes | yes | | |
| `inventory.approve` | yes | | | |
| `purchasing.view` | yes | yes | | yes |
| `purchasing.manage` | yes | yes | | |
| `purchasing.approve` | yes | | | |

A database seeded before `products.manage` existed needs a re-seed, or this one grant (admin and pharmacist):

```sql
INSERT INTO permissions (id, name, description)
VALUES (UUID(), 'products.manage', 'Create and edit products');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'products.manage'
WHERE r.name IN ('admin', 'pharmacist');
```

A database seeded before `inventory.view` and `inventory.manage` existed needs a re-seed, or these grants (`inventory.view` to admin, pharmacist and accountant; `inventory.manage` to admin and pharmacist):

```sql
INSERT INTO permissions (id, name, description) VALUES
  (UUID(), 'inventory.view', 'See stock levels and batches'),
  (UUID(), 'inventory.manage', 'Quarantine, recall and write off batches');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'inventory.view'
WHERE r.name IN ('admin', 'pharmacist', 'accountant');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.name = 'inventory.manage'
WHERE r.name IN ('admin', 'pharmacist');
```

Batch actions: quarantine (active to quarantined) and release (back to active) take a batch out of and
back into sale; recall is final, takes the batch out of sale and leaves its stock on the books (a recalled batch cannot be written off yet); a write-off
removes what is left, ending the batch expired or depleted, and records a stock movement. There are no
stock counts or transfers yet, and the "expiring" horizon is a fixed 30 days.

Purchasing and receiving add four permissions (`purchasing.view`, `purchasing.manage`, `purchasing.approve`, `inventory.receive`) and five tables (`suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`). An existing database needs `npm run db:push` for the tables and a re-seed (or equivalent `INSERT`s like the ones above) for the permissions. Stock counts add two more permissions (`inventory.adjust`, `inventory.approve`) and use the existing `inventory_adjustments` tables, so they need the re-seed only.

A purchase order is written as a draft in the creator's branch, then submitted, approved (admin only; the creator may approve their own order) and sent. Receiving needs a sent or partly received order: each delivered line is entered as accepted and rejected quantities in the order unit (a box converts to base units with its conversion factor), with a batch number and an expiry date after today for accepted goods and a reason for rejected goods. Posting is one transaction that creates one batch per accepted line, raises on hand, writes a `PURCHASE_RECEIVED` movement and moves the order to partly or fully received. Rejected goods never become stock, receiving more than is still open on a line is refused, and one supplier invoice number can be received once per order, so a retried post creates nothing. Orders cannot be edited after they are sent; there are no supplier returns, discounts, taxes or saved receipt drafts yet.

A sales scope of `all` beats `branch`, which beats `own`. A sale outside the caller's scope answers
404, as if it did not exist.

## API

Everything under `/api/v1` needs a session (except `/up` and `/health`) and answers JSON. Sign in
with the login form, keep the cookie, and call the API with it:

```bash
curl -i -c jar.txt -d "email=cashier.main@pharmavault.test" -d "password=$SEED_PASSWORD" \
  http://localhost:3000/login                       # 302, sets the pv.sid cookie
curl -b jar.txt "http://localhost:3000/api/v1/sales?status=COMPLETED&perPage=5"
curl -b jar.txt "http://localhost:3000/api/v1/sales/summary?from=2026-11-01&to=2026-11-12"
```

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/sales` | any `sales.view.*` | Paginated (`page`, `perPage` up to 100) and filterable (`status`, `paymentMethod`, `branchId`, `cashierId`, `from`, `to`, `q` for the invoice number), `sort` by `transactionDate`, `totalAmount` or `invoiceNumber` (prefix `-` for descending). |
| `GET /api/v1/sales/:id` | any `sales.view.*` | Items, the batches each came from (they add up to the line's `baseQuantity`) and payments. |
| `GET /api/v1/sales/summary` | any `sales.view.*` | Totals, daily gross, payment mix and top products for a date range of at most 366 days (default: the last 30); cash is net of change. Every date filter must lie between 2000-01-01 and 2099-12-31. |
| `GET /api/v1/products?q=` | `sales.create` | Sellable products with units, prices, barcodes and the stock the branch can sell today. An exact barcode comes first with `matchedUnitId` set. |
| `POST /api/v1/sales` | `sales.create` | Checkout. `Content-Type: application/json` and an `Idempotency-Key` header holding a UUID are required. |

Checkout takes exact decimals as strings and answers 201 with the sale (200 when the same key
was already used by the same user):

```bash
curl -b jar.txt -X POST http://localhost:3000/api/v1/sales \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"items":[{"productUnitId":"<unit id from /products>","quantity":"2"}],
       "payments":[{"method":"CASH","amount":"100.00"},
                   {"method":"GCASH","amount":"30.00","reference":"GC-123"}]}'
```

Errors share one envelope:

```json
{ "error": { "code": "insufficient_stock", "message": "…", "details": [] } }
```

| Status | `code` |
| --- | --- |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `insufficient_stock` (`details` list `productId`, `requested`, `available`), `register_closed`, `register_unavailable`, `session_exists`, `idempotency_conflict` |
| 422 | `validation_failed`, `prescription_required`, `no_price`, `payment_invalid`, `note_required` |
| 500 | `server_error` |

## Known limits

- **No CSRF tokens.** The session cookie is `SameSite=Lax`, and checkout only accepts a JSON body with an
  `Idempotency-Key` header, which a cross-site HTML form cannot send. Other POST forms are not protected.
- **Sessions live in memory.** They are lost on restart and are not for production. Rate limiting,
  `helmet` and CDN integrity hashes are not set up.
- **No tax or discounts.** Both are always zero.
- **Prescription and controlled products cannot be sold.** There is no prescription check yet, so
  checkout refuses them.
- **Payments are confirmed by hand.** A non-cash payment is recorded with the reference the cashier
  types; there is no payment provider integration.
- **A repeated `Idempotency-Key` returns the stored sale without comparing the request body.**
- No returns, refunds, voids, stock transfers or purchasing screens.

## Design and plan

The design this was built from is `docs/superpowers/specs/2026-11-12-pharmacy-pos-sales-api-design.md`
and the task plan is `docs/superpowers/plans/2026-11-12-pharmacy-pos-sales-api.md`.
