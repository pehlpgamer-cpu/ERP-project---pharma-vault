# Pharma Vault POS: sales API, pages and checkout — design

| | |
| --- | --- |
| Date | 2026-11-12 |
| Status | Draft for review. Direction approved in chat on 2026-11-12; this document fixes the details. |
| Branch | `claude/pharmacy-pos-view-engine-cc975a` (local commits only, nothing is pushed) |
| Workflow source | `pharmacy_pos_complete_user_workflow.md` (WF-02, WF-08, WF-09, WF-10, WF-11, WF-17) |
| Code audit | `.planning/codebase/*.md` (2026-11-12) |

## 1. Goal

Turn the XianFire scaffold into a working slice of the pharmacy POS. A cashier signs in, opens a register, sells stock through FEFO allocation, and staff review the resulting sales in server-rendered Xian pages and through a JSON API. Everything runs against a real MySQL 8.4 database through the existing Drizzle models.

Success means every item in section 14 passes.

## 2. Scope

**In.** Four slices. Each slice ends with a runnable app and its own commits.

1. **Data layer.** Pooled Drizzle client, schema push, deterministic dev seed.
2. **Auth and shell.** Working login, logout and register. Permission checks. Central error handling. Authenticated layout, SweetAlert2, view helpers.
3. **Sales read side.** `GET /api/v1/sales`, `GET /api/v1/sales/:id`, `GET /api/v1/sales/summary`. Dashboard, sales list and sale detail (receipt) pages.
4. **POS.** Register open and close, product lookup, checkout (FEFO, split payments, idempotent), POS page.

**Out.** Left for later passes:

- Products, inventory, purchasing, receiving, transfers, adjustments, returns and refunds pages.
- Prescription verification (WF-10). Rx products are blocked at the POS instead (section 9.4).
- Tax and discount rules. Payment-provider integration.
- Reports beyond the sales summary. CSV or PDF export.
- CSRF tokens, rate limiting, `helmet`, Redis session store (section 10 lists the interim mitigations).
- Cleanup of Electron scripts, `Dockerfile.prod`, stale dependencies and the legacy migrations.

## 3. Starting point

Verified by reading the code on 2026-11-12:

- **No database access at runtime.** `database/database.js` exports nothing, reads `PROD_MYSQL_USER` and `MYSQL_NAME` (names nothing else defines) and imports `relations` without `.js`. `drizzle.config.js` hard-codes `root` and a literal password.
- **Crash bugs.** `authController.login`, `authController.register` and `userController.index` throw `ReferenceError` inside async handlers. Express 4 does not catch rejected promises, so one request can kill the process on Node 25.
- **Broken shell.** `views/layouts/authenticated.xian` includes `{{>sideNavBar}}`, which does not exist. Nav links and redirects use `/login`, `/dashboard` and `/register`, but the routes are `/login-page`, `/dashboard-page` and `/register-page`. SweetAlert2 is not loaded.
- **`RouteBuilder`** (`src/RouteBuilder.js`). `create` and `edit` are never reached: `create` shares `GET /x` with `index`, and `edit` shares `GET /x/:id` with `show`. The missing-handler error message references an undefined `uri`.
- **Schema has no price source.** `products` and `product_units` carry no selling price, and no table generates invoice numbers. Checkout cannot work without both (section 4, decision 8).
- **Environment.** No MySQL is running and the Docker daemon is off. Laragon ships MySQL 8.4.3 (`C:\laragon\bin\mysql\mysql-8.4.3-winx64`), the same major version as `compose.dev.yaml`. Verification uses a throwaway instance (section 11).

## 4. Decisions

| # | Decision | Reason |
| --- | --- | --- |
| 1 | Data access is Drizzle on a `mysql2` pool, using the existing models and `defineRelations`. | Models and relations are already written. Raw SQL ignores them; mocks are throwaway. |
| 2 | Business logic lives in `app/services/**`. Controllers stay thin. Pages and API call the same service functions. | The two outputs cannot disagree, and services are testable without HTTP. |
| 3 | Web and API share session-cookie authentication. Authorization checks permissions, never role names. API failures return JSON 401 or 403. | No new tables. Bearer tokens are a follow-up if external clients appear. |
| 4 | Sales visibility comes from three permissions: `sales.view.own`, `sales.view.branch`, `sales.view.all`. The widest one a user holds wins. | Matches the access matrix in the workflow doc (cashier sees own shift, accountant sees all). |
| 5 | Checkout is `POST /api/v1/sales` (JSON). HTML routes only render pages and handle the login, register and register-session forms. | One write path, usable by the POS page and by other clients. |
| 6 | Decimals stay strings end to end. Arithmetic uses a small BigInt-scaled helper (`app/services/support/decimal.js`). Rounding is half-up to 2 places. | No float drift in money. No new dependency. |
| 7 | All timestamps are stored and sent as UTC. The business time zone is `APP_TIMEZONE` (default `Asia/Manila`). It drives display, query dates and day grouping. | PHP, GCash and Maya imply a no-DST zone; one fixed offset is enough (section 13, R6). |
| 8 | Two new tables: `product_prices` and `document_sequences`. | Workflow doc section 24.2 items 1 and 13. Needed for server-side pricing and gap-free invoice numbers. |
| 9 | No tax or discount at checkout. Both are recorded as `0.00`. Prices are treated as final. | The workflow doc says these rules need verified local policy. Not invented here. |
| 10 | Rx and controlled products are rejected at checkout. | WF-09 requires an approved pharmacist verification, which is not built. Never sell silently. |
| 11 | Card, GCash, Maya and bank-transfer payments are recorded as `PAID` when the cashier supplies a reference number. | No provider integration exists. The cashier confirms on the terminal or app. |
| 12 | Cash convention: `sale_payments.amount` is the amount tendered, `sales.amount_paid` the total tendered, `sales.change_amount` the change, `cash_transactions` `CASH_SALE` the net kept (tendered minus change). No `OPENING_CASH` ledger rows are written; `cash_register_sessions.opening_cash` is the only opening figure. | One convention applied everywhere (workflow doc WF-17 warns about double counting). |
| 13 | Cost data (`unit_cost`) is never returned by the sales API or shown on pages. | Margins need their own permission design. |
| 14 | The schema is created with `drizzle-kit push`. Legacy files in `database/migrations` stay untouched. | The codebase map says they contradict the models. |
| 15 | Template strict mode is on whenever `NODE_ENV` is not `production` (today it is development only). | Tests then catch missing template variables. |

## 5. Architecture

### 5.1 Layers

```text
routes/web.js, routes/api_v1.js
  -> middleware: session -> loadUser -> requireAuth / requirePermission
  -> controllers (thin; app/http/controllers/**)
       -> requests (zod; app/http/requests/**)        parse and validate input
       -> services (app/services/**)                  rules, queries, transactions
       -> resources (app/http/resources/**)           JSON shape for the API
       -> views (views/pages/**, Xian)                HTML for pages
  -> database/client.js (Drizzle on mysql2 pool) -> MySQL 8.4
```

### 5.2 New and changed files

```text
database/client.js                      pooled client; database/database.js re-exports it
database/seed/**                        deterministic dev seed (replays 30 days through the real services)
app/models/product-prices.js            new table
app/models/document-sequences.js        new table
app/models/relations/relations.js       register both
app/services/support/decimal.js         scaled decimal math
app/services/support/time.js            business-zone helpers
app/services/auth/**                    login, register, permission loading
app/services/audit/auditLog.js          append to audit_logs
app/services/sales/salesQuery.js        list, detail, summary (scope-aware)
app/services/sales/fefo.js              pure allocator
app/services/sales/checkout.js          transactional checkout
app/services/register/registerSessions.js  open, close, current
app/services/catalog/productLookup.js   POS product search
app/http/middleware/                    asyncHandler, loadUser, requireAuth, requirePermission, errorHandler, notFound
app/http/requests/                      shared validate helper plus one file per endpoint
app/http/resources/                     saleResource, productResource
app/http/controllers/                   auth, dashboard, sales, pos, cashRegister, users, api/v1/{sales,products}
views/layouts/                          authenticated (new body), main (tidied)
views/partials/                         sideNavBar, swal/init, components/{pagination,stat-card,page-header,empty-state}
views/pages/                            dashboard, sales/{index,show}, pos/index, cash-register/index, errors/{403,404,500}, home, users
views/helpers/                          eq, gt, and, or, not, can, isActive, formatDate, formatDateTime, formatNumber, badge
tests/                                  unit, feature, helpers (see section 11)
```

### 5.3 Conventions

- **IDs** are UUID strings generated by the app (`uuidPrimaryKey`). Treat them as opaque.
- **Decimals.** MySQL `DECIMAL` arrives as a string and the API sends it as a string with fixed scale: money 2 places, quantities 3, unit prices 4. Never convert to `Number` in services.
- **Time.** The pool uses `timezone: "Z"` and each connection runs `SET time_zone = '+00:00'`. The API sends ISO-8601 with `Z`. Query parameters named `from` and `to` are `YYYY-MM-DD` dates in the business zone, both ends inclusive.
- **API errors** use one envelope: `{ "error": { "code": "snake_case", "message": "...", "details": [] } }`. Codes used: `unauthenticated` 401, `forbidden` 403, `not_found` 404, `validation_failed` 422, `insufficient_stock` 409, `register_closed` 409, `idempotency_conflict` 409, `prescription_required` 422, `no_price` 422, `payment_invalid` 422, `server_error` 500.
- **JSON versus HTML.** A request wants JSON when its path starts with `/api/` or `Accept` prefers JSON. Auth and error middleware branch on that.
- **Views.** Follow the `xian-view-engine` skill: pages hold content only; every render passes `pageTitle` and every variable the template prints; app pages use `layout: "authenticated"`; reusable pieces are partials under `views/partials/components`; custom CSS goes in `@layer components`; icons come from the skill's verified Bootstrap Icons list; `check-views.mjs` runs after every view change.
- **Code style.** New code must pass `oxlint` (`curly: all`, `arrow-body-style: always`) and `oxfmt`. New files use LF endings (`.editorconfig`).

## 6. Slice 1: data layer

**Client.** `database/client.js` creates one `mysql2` pool and wraps it with Drizzle, passing `relations` and `casing: "snake_case"` (the models rely on it for unnamed columns). It exports `db`, `pool` and `closeDb()`. Environment: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, the names `compose.dev.yaml` already passes to the dev container. Pool options: `waitForConnections`, `connectionLimit: 10`, `timezone: "Z"`, decimals as strings, per-connection `SET time_zone = '+00:00'`.

**Configuration.** `drizzle.config.js` reads the same variables instead of its hard-coded credentials. `.env.example` gains `MYSQL_HOST`, `MYSQL_PORT`, `APP_TIMEZONE`, `EXPIRY_BUFFER_DAYS`, `REGISTER_VARIANCE_THRESHOLD`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY`, `SEED_PASSWORD`.

**Schema.** `npm run db:push` runs `drizzle-kit push`. `npm run db:push:test` does the same against the test database (section 11). Two models are added:

- `product_prices`: `id`, `product_unit_id` (FK), `branch_id` (nullable FK, null means every branch), `unit_price DECIMAL(14,4) >= 0`, `effective_from DATETIME`, `effective_to DATETIME null`, `is_active`, timestamps. Lookup rule: among active rows effective now, a branch-specific row beats a global row; within the same specificity the latest `effective_from` wins. Prices are per selling unit.
- `document_sequences`: `scope VARCHAR(100)` primary key (for example `invoice:MAIN:20261112`), `last_value INT UNSIGNED`, `updated_at`.

**Seed.** `npm run db:seed` refuses to run when `NODE_ENV=production` or when `branches` already has rows. It is deterministic (seeded PRNG) and has two stages, delivered in separate commits:

1. **Base data.** 2 branches (`MAIN`, `NORTH`), the permission catalog, 4 roles, and 5 users: `admin@pharmavault.test`, `pharmacist@pharmavault.test`, `cashier.main@pharmavault.test` and `accountant@pharmavault.test` in `MAIN`, and `cashier.north@pharmavault.test` in `NORTH`. All share the password in `SEED_PASSWORD` (at least 14 characters, printed once). About 16 products (OTC plus Rx) with units, barcodes, `product_prices` and 2 to 3 batches per product per branch (some expired, quarantined or recalled so the eligibility rules are visible), a few customers, and one register per branch.
2. **History.** 30 days of operation replayed through the real services: for each business day each cashier opens a session, sells through `postSale` with the clock injected, then closes with a small variance. One session stays open today so the POS works right after seeding.

Replaying history through the real services keeps every invariant (FEFO rows, ledger, cash transactions) true by construction and doubles as an integration test. Tests build their own fixtures and never depend on the seed.

**Permission catalog and roles.**

| Permission | admin | pharmacist | cashier | accountant |
| --- | :-: | :-: | :-: | :-: |
| `dashboard.view` | yes | yes | yes | yes |
| `sales.view.own` | | | yes | |
| `sales.view.branch` | | yes | | |
| `sales.view.all` | yes | | | yes |
| `sales.create` | yes | yes | yes | |
| `register.manage` | yes | yes | yes | |
| `users.manage` | yes | | | |

## 7. Slice 2: auth, errors, shell

**Session.** `express-session` gets `name: "pv.sid"`, 8-hour `maxAge`, `httpOnly`, `sameSite: "lax"`, `secure` from `SESSION_COOKIE_SECURE` (default true when `NODE_ENV=production`), and `trust proxy` from `TRUST_PROXY`. In production the server refuses to start without `SECRET_KEY`. The in-memory store stays (Redis is a follow-up).

**Login (`POST /login`).** Validate `{ email, password }` with zod. Look up the user, always run an argon2 verify (a dummy hash when the user is missing) and answer every failure with the same flash message "Invalid email or password". Inactive users fail the same way. On success: `session.regenerate`, store `userId`, write an audit row, redirect to the stored return URL or `/dashboard-page`. Failures write an audit row without the password.

**Register (`POST /register`).** Name 2 to 100 characters, valid email, password 14 to 128 characters, no trimming of the password. The account is created active with no roles and no branch, so it can sign in and see nothing until an admin assigns a role. Duplicate emails get a generic failure message.

**Logout.** Moves from `GET /logout` to `POST /logout` (a form in the sidebar). It destroys the session and clears the cookie.

**Middleware.**

- `loadUser` runs after the session. It loads the user, branch, roles and the flattened permission names. A missing or inactive user destroys the session. It sets `req.user` and `res.locals.currentUser` (`{ id, name, email, branchName, roles, permissions }`, or `null` when signed out so strict-mode templates can test it) and `res.locals.currentPath`.
- `requireAuth` redirects pages to `/login-page` (remembering the target for GET requests) and returns JSON 401 for the API.
- `requirePermission(...names)` passes when the user holds any of the names. Otherwise it renders `errors/403` or returns JSON 403.
- `asyncHandler` forwards rejections to `next`. `RouteBuilder` wraps every handler it registers with it, and route files wrap explicit handlers.
- `notFound` and `errorHandler` close the stack. `ValidationError` becomes 422 JSON, or a flash plus redirect for form pages. Other errors are logged server-side and answered with a generic message. Development and test additionally show the message and stack on the 500 page.

**`RouteBuilder` fix.** Routes are registered in the order `index, create, store, show, edit, update, replace, destroy`. `create` becomes `GET {uri}/create` and `edit` becomes `GET {uri}/:id/edit`. The error message uses the real URI.

**Existing controllers.** `userController.index` renders real users (name, email, branch, role names, active) behind `users.manage`; the mock array and the dead `insert.data` line go. `/users` registers only `index`, and `/audit-trail` is not registered until it has a page. The unfinished handlers in both controllers answer `501 Not Implemented`, so nothing can hang if a route is added later.

**Shell and views** (Xian skill conventions apply to every file below).

- `views/layouts/authenticated.xian` becomes the app shell: `{{>head}}`, a `sideNavBar` partial filtered by permission, a top bar with branch and user, `{{{body}}}`, footer. `main.xian` stays for public pages; its `text-xxl` is fixed and its style block moves inside `<body>`.
- `views/partials/head.xian` loads SweetAlert2 and includes `swal/init` (copied from the skill's `assets/swal/init.xian`), so flash messages become toasts and `data-confirm` works.
- Helpers, one per file: `eq`, `gt`, `and`, `or`, `not`, `can`, `isActive`, `formatDate`, `formatDateTime`, `formatNumber`, `badge`. Date helpers format in `APP_TIMEZONE`. `currency` stays.
- Pages: `home` (real landing page, redirects signed-in users to the dashboard), `errors/403`, `errors/404`, `errors/500`, `users`. Dead links point to the `-page` routes.
- Every page controller passes `pageTitle` and every variable its template prints. `node .claude/skills/xian-view-engine/scripts/check-views.mjs` must exit 0.

## 8. Slice 3: sales read side

### 8.1 Visibility scope

`salesScope(user)` returns `all`, `branch`, `own` or `none` from the user's permissions. It is applied inside the service, so API and pages behave identically.

| Scope | Rows returned |
| --- | --- |
| `all` | every branch. `branchId` filter allowed. |
| `branch` | the user's branch only. A different `branchId` gives 403. A user without a branch resolves to `none`. |
| `own` | sales the user rang up. A `branchId` other than the user's branch, or a `cashierId` other than the user's id, gives 403. |
| `none` | 403, also enforced by the route-level permission check |

A detail request outside the scope returns 404, not 403, so ids cannot be probed.

### 8.2 API

All routes require authentication. Base path `/api/v1`.

**`GET /sales`** lists sales.

| Query | Rule |
| --- | --- |
| `page`, `perPage` | integers, `page >= 1`, `perPage` 1 to 100, default 20 |
| `status` | comma-separated values from `PENDING, COMPLETED, PARTIALLY_REFUNDED, REFUNDED, VOIDED` |
| `branchId`, `cashierId` | UUID, subject to scope |
| `from`, `to` | `YYYY-MM-DD` in the business zone, inclusive, `from <= to` |
| `paymentMethod` | one of `CASH, CARD, GCASH, MAYA, BANK_TRANSFER, OTHER`: sales that have a payment of that method |
| `q` | up to 100 characters, matches the invoice number (contains, wildcards escaped) |
| `sort` | `transactionDate`, `totalAmount` or `invoiceNumber`, prefix `-` for descending, default `-transactionDate` |

Response:

```json
{
  "data": [
    {
      "id": "…",
      "invoiceNumber": "MAIN-20261112-0007",
      "status": "COMPLETED",
      "transactionDate": "2026-11-12T03:15:00.000Z",
      "branch": { "id": "…", "code": "MAIN", "name": "Main Branch" },
      "cashier": { "id": "…", "name": "Ana Reyes" },
      "customer": null,
      "register": { "id": "…", "code": "R1", "name": "Counter 1" },
      "itemCount": 2,
      "paymentMethods": ["CASH"],
      "totals": { "subtotal": "180.00", "discount": "0.00", "tax": "0.00", "total": "180.00", "paid": "200.00", "change": "20.00" }
    }
  ],
  "meta": { "page": 1, "perPage": 20, "total": 58, "totalPages": 3 },
  "links": { "self": "…", "first": "…", "prev": null, "next": "…", "last": "…" }
}
```

**`GET /sales/:id`** returns one sale with the same header fields plus:

```json
{
  "items": [
    {
      "id": "…",
      "productId": "…",
      "productName": "Paracetamol 500 mg Tablet",
      "genericName": "Paracetamol",
      "unit": { "id": "…", "name": "Strip", "abbreviation": "strip" },
      "quantity": "2.000",
      "baseQuantity": "20.000",
      "unitPrice": "30.0000",
      "discount": "0.00",
      "tax": "0.00",
      "subtotal": "60.00",
      "total": "60.00",
      "batches": [{ "batchId": "…", "batchNumber": "PARA-2601", "expirationDate": "2027-03-31", "quantity": "20.000" }]
    }
  ],
  "payments": [{ "id": "…", "method": "CASH", "amount": "200.00", "reference": null, "status": "PAID", "paidAt": "…" }]
}
```

The batch quantities of an item add up to its `baseQuantity` (workflow invariant). Customer data is limited to id, number and name.

**`GET /sales/summary`** accepts `from`, `to` (default: the last 30 days), `branchId`, `cashierId` under the same scope rules. It counts sales with status `COMPLETED`, `PARTIALLY_REFUNDED` or `REFUNDED` as sales that happened. It counts `VOIDED` separately and ignores `PENDING`.

```json
{
  "data": {
    "period": { "from": "2026-10-14", "to": "2026-11-12", "timezone": "Asia/Manila" },
    "totals": {
      "salesCount": 58, "grossSales": "…", "discounts": "…", "tax": "…",
      "refunds": "…", "netSales": "…", "averageSale": "…",
      "voidedCount": 0, "voidedTotal": "0.00"
    },
    "byDay": [{ "date": "2026-11-12", "salesCount": 5, "grossSales": "…" }],
    "byPaymentMethod": [{ "method": "CASH", "paymentsCount": 40, "amount": "…" }],
    "topProducts": [{ "productId": "…", "productName": "…", "baseQuantity": "…", "revenue": "…" }]
  }
}
```

`refunds` sums `refunds.amount` with status `PROCESSED` and `processed_at` inside the period, joined through `sales_returns` to sales in scope (empty until the returns module exists). `netSales = grossSales - refunds`. `byPaymentMethod` counts only `PAID` payments of sales that happened, and `amount` is net applied: the cash figure is tendered minus change. `byDay` lists every day in the period, including days with no sales. Day buckets use the fixed business-zone offset.

### 8.3 Pages

- **`GET /dashboard-page`** (`dashboard.view`). Cards for today's sales count and gross, a 14-day bar chart of daily gross, payment mix, the ten latest sales, the user's register status, and a "New sale" button when `sales.create` is held. The chart and tiles follow the `dataviz` skill and use no chart library. A user with no permissions sees an "awaiting access" notice.
- **`GET /sales`** (any `sales.view.*`). Filter form (date range with presets, status, payment method, invoice search; cashier and branch selectors only where the scope allows), results table, pagination partial, empty state. Invalid filters re-render with defaults and an error alert.
- **`GET /sales/:id`**. Receipt layout: header, items with an expandable batch-traceability row, payments, totals (discount and tax rows only when above zero), a print button with print CSS. `?print=1` opens the print dialog on load. The page prints stored snapshots only, so reprinting never re-runs a sale.

## 9. Slice 4: POS

### 9.1 Register sessions (WF-08, WF-17)

- **Open** (`POST /cash-register/open`, permission `register.manage`). Inside one `READ COMMITTED` transaction, lock the user's row, then the register row (`SELECT … FOR UPDATE`), then check that the register is active and in the user's branch, that no `OPEN` session exists for the register, and that the user has none open. Insert the session with `opening_cash >= 0`. Concurrent opens serialize on the locks.
- **Page** (`GET /cash-register-page`). Shows the current session (opened at, opening cash, cash sales so far, expected cash) with a close form, or an open form listing the branch's active registers.
- **Close** (`POST /cash-register/close`). Only the session's own cashier can close it (a manager override is a follow-up). Inside a `READ COMMITTED` transaction, lock the session row. `expected = opening_cash + sum(CASH_SALE) + sum(CASH_IN) - sum(CASH_OUT) - sum(CASH_REFUND)`. `variance = counted - expected`. When `abs(variance) > REGISTER_VARIANCE_THRESHOLD` (default `50.00`) a note is required and the status becomes `RECONCILIATION_REQUIRED`; otherwise `CLOSED`. Store `expected_cash`, `actual_cash`, `variance`, `closed_at`; write the note to the audit log. No ledger row is written for the variance (`cash_transactions.amount` cannot be negative and the variance lives on the session).

### 9.2 Product lookup

`GET /api/v1/products?q=&limit=` (permission `sales.create`, `limit` 1 to 50, default 20). An exact barcode match comes first and preselects that unit. Otherwise it matches SKU, product, generic and brand name (contains, wildcards escaped). It returns active products with at least one active sellable unit, for the user's branch:

```json
{
  "data": [{
    "id": "…", "sku": "PARA-500-001", "name": "Paracetamol 500 mg Tablet", "genericName": "Paracetamol",
    "strength": "500 mg", "dosageForm": "Tablet", "classification": "OTC", "requiresPrescription": false,
    "availableBaseQuantity": "1240.000",
    "units": [{ "productUnitId": "…", "name": "Strip", "abbreviation": "strip", "conversionFactor": "10.000", "price": "30.0000", "barcodes": ["4801234567890"] }]
  }]
}
```

`availableBaseQuantity` sums the batches that pass the eligibility rules in 9.3. A unit with no effective price is returned with `price: null` and cannot be added to a cart.

### 9.3 FEFO allocation

`app/services/sales/fefo.js` is a pure function: `allocateFefo(batches, needed, { today, bufferDays })` returns `{ allocations: [{ batchId, quantity }], shortfall }`. Quantities are scaled decimals. It re-checks eligibility itself so a wrong query cannot sell bad stock.

A batch is eligible when all of these hold:

- status is `ACTIVE`, and `quantity_available > 0`
- `expiration_date IS NULL` or `expiration_date >= today + EXPIRY_BUFFER_DAYS` (default 0), where `today` is the business-zone date, not the database date

Order: dated batches by `expiration_date` ascending, then `received_at`, then `id`. Batches without an expiry date sort last, so they never outrank an expiring batch. They are sellable (devices, supplies).

### 9.4 Checkout (`POST /api/v1/sales`)

Permission `sales.create`. The user must have an `OPEN` register session (which implies a branch); otherwise 409 `register_closed`. Header `Idempotency-Key` is required and must be a UUID.

Request:

```json
{
  "items": [{ "productUnitId": "…", "quantity": "2" }],
  "payments": [{ "method": "CASH", "amount": "200.00" }, { "method": "GCASH", "amount": "100.00", "reference": "GC-123" }],
  "customerId": null
}
```

Response: 201 with the sale detail (section 8.2). A replay with a known `Idempotency-Key` from the same user returns 200 with the stored sale; from a different user it returns 409 `idempotency_conflict`.

Input validation (422 `validation_failed`): 1 to 50 item lines, quantity greater than zero with at most 3 decimals, known units that are active and sellable, at least one payment with a positive amount. A product is blocked, and the whole request rejected with 422 `prescription_required`, unless its classification is `OTC` and `requires_prescription` is false.

**Transaction** (isolation `READ COMMITTED`; up to 3 attempts on deadlock with the same key). Before it starts, a lookup by `Idempotency-Key` returns the stored sale if one exists.

1. Find the user's `OPEN` session and lock it `FOR SHARE`, so a concurrent close waits. None found: 409 `register_closed`.
2. Resolve units and products and apply the rules above. Look up the effective price of each line (422 `no_price`). Compute line subtotals and totals with the decimal helper: `subtotal = sum(line subtotals)`, `discount = 0`, `tax = 0`, `total = subtotal`, `change = tendered - total`. Validate the payments (422 `payment_invalid`): `sum(payments) >= total`; non-cash payments together do not exceed `total`, which guarantees change comes out of cash; every non-cash payment has a non-empty `reference`. Nothing beyond the session is locked yet, so bad requests fail cheaply.
3. Lock the `inventories` rows of all products in ascending `product_id` order.
4. For each line in order: convert to base units (`quantity * conversion_factor`), select the product's candidate batches `FOR UPDATE`, run `allocateFefo` (409 `insufficient_stock` with product, requested and available), then decrement each batch and set `DEPLETED` at zero. Lines are processed one after another against updated rows, so two lines for the same product cannot oversell.
5. Generate the invoice number last, to keep that lock short: `INSERT … ON DUPLICATE KEY UPDATE last_value = last_value + 1` on the `document_sequences` row `invoice:{branchCode}:{YYYYMMDD}`, then read it back in the same transaction. Format `{branchCode}-{YYYYMMDD}-{seq:4}`. A rollback undoes the increment, so numbering has no gaps.
6. Insert in foreign-key order: `sales` (status `COMPLETED`, id generated by the app), `sale_items` (name, generic name, unit and price snapshots; `unit_cost` is the weighted average cost per selling unit), `sale_item_batches`, `inventory_movements` (`SALE`, signed quantity, before and after, batch cost), `sale_payments` (`PAID`, `paid_at` now), a `CASH_SALE` cash transaction for the cash kept (tendered minus change) when any cash was tendered, and an audit row. Decrement `inventories.quantity_on_hand` by the base quantity sold.
7. Commit. If the `sales` insert hits `uq_sales_idempotency` (a concurrent duplicate), the transaction rolls back and the stored sale is returned.

Any failure rolls back everything: no partial stock change survives. Locks are taken in one order everywhere (session, inventories by product id, batches, sequence row), so concurrent checkouts cannot deadlock on each other.

`postSale(tx, input, { now })` holds steps 1 to 6 and takes the clock as a parameter. The HTTP handler passes the real clock; the seed and tests pass fixed instants.

### 9.5 POS page (`GET /pos-page`)

Requires `sales.create` and an open session; otherwise it redirects to `/cash-register-page` with a flash message. The page has a search box that is focused on load (Enter on an exact barcode adds the item), a cart table with quantity and unit selectors, a payments panel (method, amount, reference, tendered cash with live change) and a Complete button. The browser shows totals for convenience only; the server recomputes everything. The page sends `fetch POST /api/v1/sales` with one `Idempotency-Key` per sale attempt, reused on retry. Success redirects to `/sales/:id?print=1`. Failure shows the error code's message through `xian.error` and keeps the cart. Rx products show a badge and a disabled add button with the reason. Server data reaches the script through `data-*` attributes and `{{json}}`, never inside the script body.

## 10. Security notes

- Passwords: argon2id through `config/cryptography.js` (numeric options coerced). The unused salt and pepper construction is dropped. Passwords are never trimmed or logged.
- Every route checks permissions on the server. The sidebar is a convenience, not a control.
- Out-of-scope sale ids return 404. The API omits costs, idempotency keys and customer contact details.
- All SQL goes through Drizzle parameters. `LIKE` inputs escape `%`, `_` and `\`.
- Templates keep Handlebars escaping on. `{{{ }}}` is used only for `{{{body}}}`.
- **Interim CSRF mitigation.** The session cookie is `SameSite=Lax`. Checkout accepts only `Content-Type: application/json` plus the idempotency header, which a cross-site form cannot send, and no CORS headers are enabled. Logout is POST. CSRF tokens remain a follow-up.
- Rate limiting, `helmet` and CDN integrity hashes remain follow-ups. The in-memory session store is not for production.

## 11. Testing and verification

**Throwaway MySQL.** Start `mysqld.exe` from Laragon with `--initialize-insecure`, a data directory under the scratchpad, port 3317 and `127.0.0.1` binding. Create a dev database and a `_test` database, point `.env` and `.env.test` at it, and delete the instance at the end. Laragon's own data directory is not touched and nothing is downloaded.

**Test database guard.** The harness refuses to truncate unless `MYSQL_DATABASE` ends in `_test`. `.env.test.example` documents the values; `bin/test.js` loads `.env.test` and sets `NODE_ENV=test`.

**Runner.** Japa stays. `bin/test.js` starts the app in process on an ephemeral port (after `bootstrap()`) and points the API client at it. `package.json` `test` becomes `node bin/test.js`. The placeholder specs (`maths`, `getProducts`, and the browser spec that visits an external site) are replaced, and the `browser` suite is not part of `npm test`. Tests build their own fixtures and never depend on the seed.

| Suite | Covers |
| --- | --- |
| unit | `decimal` math and rounding, `fefo` (order, expired, quarantined, recalled, null expiry, partial batches, shortfall), `time` day boundaries, request validators, `salesScope`, view helpers |
| feature | auth (login, wrong password, inactive user, logout, 401 JSON), permissions (403, scope filtering, 404 outside scope), sales list filters, sort, pagination, `:id` invariants, summary totals against hand-computed fixtures, register open and close (including concurrent open), checkout (happy path, split payments, change, insufficient stock rolls back everything, Rx rejected, no price, expired batch skipped, idempotent replay, two concurrent checkouts for the last units yield exactly one success) |
| render | every page renders in strict mode with realistic data, plus 403, 404 and 500 |

**Also.** `check-views.mjs` exits 0. `oxlint` and `oxfmt --check` pass on new files. Final manual pass in the built-in browser: log in as each seeded role, open every page, run a checkout, print a receipt, check the console for errors.

## 12. Delivery

Small local commits on the working branch, conventional-commit messages, one logical change each. Expected sequence:

1. `docs:` this design, then the implementation plan.
2. `feat(db):` client, env, scripts, and a spike proving push, query and `FOR UPDATE` work on the installed Drizzle release candidate.
3. `feat(db):` `product_prices`, `document_sequences`, relations.
4. `feat(db):` base seed (stage 1).
5. `feat(core):` decimal and time helpers with tests.
6. `fix(routing):` `RouteBuilder` order and async wrapping.
7. `feat(auth):` middleware, login, register, logout, audit helper, error handling.
8. `feat(views):` layouts, partials, helpers, SweetAlert2, error pages.
9. `feat(sales):` service, resources, API, tests.
10. `feat(sales):` dashboard, list and detail pages.
11. `feat(pos):` register sessions, FEFO, checkout, product lookup, tests.
12. `feat(pos):` POS page and cash-register page.
13. `feat(db):` seed history (stage 2).
14. `docs:` README, `.env.example`, `.env.test.example`.

The plan may split these further. Each commit leaves the tests green. No push, no PR, no remote operations.

## 13. Risks and fallbacks

| # | Risk | Fallback |
| --- | --- | --- |
| R1 | The `drizzle-orm` and `drizzle-kit` `1.0.0-rc` APIs (relational queries, `push`, `.for("update")`) may differ from what this design assumes. | Commit 2 is a spike that proves them first. Fall back to `drizzle-kit export` plus executing the SQL, and to `tx.execute(sql…)` for locking reads. |
| R2 | The invoice sequence row is a per-branch, per-day hot spot. | It is locked last in the transaction, so only the final inserts serialize. Revisit only if measured throughput requires it. |
| R3 | Seeding through `postSale` makes the seed depend on the service code. | Intentional. A broken service fails the seed loudly. |
| R4 | Public registration creates role-less accounts. | They cannot reach any data. An admin UI for roles is a follow-up. |
| R5 | No CSRF token. | Section 10 mitigations. Add `csrf-csrf` or similar next. |
| R6 | Day grouping assumes a fixed UTC offset. | Correct for `Asia/Manila`. A DST zone would misgroup around transitions; load MySQL time-zone tables and use `CONVERT_TZ` if that ever matters. |
| R7 | The expiry rule treats the printed date as the last sellable day. | `EXPIRY_BUFFER_DAYS` makes it stricter. The pharmacist or owner should confirm the policy. |
| R8 | Cash and non-cash conventions (decision 12) affect reconciliation reports later. | Documented once here and in code comments; later reports follow the same convention. |

## 14. Acceptance criteria

1. On an empty MySQL 8.4 database, `npm run db:push`, `npm run db:seed` and `npm start` produce a running app with seeded data.
2. Each seeded role signs in and sees only what its permissions allow. Wrong passwords, unknown emails and inactive users get the same message. Logout works.
3. `GET /api/v1/sales` is paginated and filterable. It returns 401 JSON without a session, 403 for a user without a sales scope, and only own sales for a cashier.
4. `GET /api/v1/sales/:id` returns items, batch allocations (summing to each `baseQuantity`) and payments. It returns 404 outside the caller's scope.
5. `GET /api/v1/sales/summary` matches totals computed independently from the same rows, including cash net of change.
6. Dashboard, sales list, sale detail, POS, cash-register, users and error pages render in strict mode, and `check-views.mjs` exits 0.
7. Checkout allocates FEFO, skips expired, quarantined, recalled and depleted batches, rejects insufficient stock without side effects, rejects Rx products, validates split payments and change, and is idempotent.
8. Two concurrent checkouts for the last units produce exactly one sale.
9. Register open rejects a second open session for the same register or the same user, including under concurrency. Register close computes expected cash and variance as in 9.1.
10. All suites pass against the `_test` database. `oxlint` and `oxfmt --check` pass on new code.
11. The history shows the commit sequence in section 12 with nothing pushed.
