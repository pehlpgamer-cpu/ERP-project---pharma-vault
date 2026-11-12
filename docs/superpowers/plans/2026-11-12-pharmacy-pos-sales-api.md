# Pharma Vault POS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working pharmacy POS slice: staff sign in, open a register, sell with FEFO checkout, and review sales in Xian pages and a JSON API on MySQL 8.4.

**Architecture:** Drizzle on a `mysql2` pool. Business rules live in `app/services/**` and are shared by thin controllers: JSON through `app/http/resources`, HTML through Xian views. Auth is a session cookie with permission-scoped access. Checkout is one `READ COMMITTED` transaction with a fixed lock order.

**Tech Stack:** Node 24+ ESM, Express 4, Xian (Handlebars) with Tailwind v4 CDN and SweetAlert2, Drizzle `^1.0.0-rc.4`, `mysql2`, zod 4, argon2, Japa.

**Spec:** `docs/superpowers/specs/2026-11-12-pharmacy-pos-sales-api-design.md`

## Global Constraints

- Node `>=24`, ESM only, Express 4, MySQL 8.4, Drizzle `^1.0.0-rc.4`, zod 4 (`import * as z from "zod"`).
- Decimals are strings end to end. Scales: money 2, quantities 3, unit prices 4. Rounding is half-up (away from zero) to 2 places. Never `Number()` a money or quantity value in `app/services/**`.
- IDs are app-generated UUIDs (`randomUUID` through `uuidPrimaryKey`).
- Time is stored and sent as UTC; every connection runs `SET time_zone = '+00:00'`. Business zone is `APP_TIMEZONE` (default `Asia/Manila`). Query `from` and `to` are `YYYY-MM-DD` in the business zone, both inclusive.
- API errors use `{ "error": { "code", "message", "details": [] } }` with codes `unauthenticated` 401, `forbidden` 403, `not_found` 404, `validation_failed` 422, `insufficient_stock` 409, `register_closed` 409, `idempotency_conflict` 409, `prescription_required` 422, `no_price` 422, `payment_invalid` 422, `server_error` 500.
- Pagination: `page >= 1`, `perPage` 1 to 100, default 20.
- Session cookie: name `pv.sid`, 8-hour `maxAge`, `httpOnly`, `sameSite: "lax"`, `secure` true by default when `NODE_ENV=production`. Passwords are 14 to 128 characters and never trimmed.
- Permissions: `dashboard.view`, `sales.view.own`, `sales.view.branch`, `sales.view.all`, `sales.create`, `register.manage`, `users.manage`. Roles: `admin` (all seven), `pharmacist` (`dashboard.view`, `sales.view.branch`, `sales.create`, `register.manage`), `cashier` (`dashboard.view`, `sales.view.own`, `sales.create`, `register.manage`), `accountant` (`dashboard.view`, `sales.view.all`).
- Defaults: `EXPIRY_BUFFER_DAYS=0`, `REGISTER_VARIANCE_THRESHOLD=50.00`.
- Checkout and register open/close use `READ COMMITTED`. Lock order everywhere: register session (`FOR SHARE`), `inventories` by ascending `product_id`, batches, `document_sequences` row.
- The test database name must end in `_test`; the harness refuses otherwise.
- Style: run `npx oxlint` and `npx oxfmt` on every file a task touches before its commit (`curly: all`, `arrow-body-style: always`). New files use LF.
- Views: invoke the `xian-view-engine` skill before editing any `.xian` file. Every render passes `pageTitle` and every variable the template prints. `npm run views:check` must exit 0 once Task 9 creates it.
- Git: local commits only, never push. Conventional-commit subjects. Stage explicit paths (never `git add -A`, never `.env` or `.env.test`). End each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test commands: `npm test -- --files=<fragment>` runs matching files; `npm test` runs all.

## Review Focus

1. A search `q` containing `%`, `_` or `\` matches those characters literally (`q=%` returns nothing, not every row). Tasks 12 and 17.
2. `2026-11-12T16:00:00Z` is 2026-11-13 00:00 in `Asia/Manila`: that sale belongs to Nov 13 in `byDay`, and `from=to=2026-11-12` excludes it. Task 12.
3. Malformed or extreme checkout input (quantity `0`, `-1`, `"abc"`, `"0.0001"`, `"1e3"`, `"99999999999999999999"`, 51 lines, no payments, non-JSON body, malformed JSON) returns a 422 envelope, never a 500, and changes no stock. Task 19.
4. Double-clicking Complete sends the same `Idempotency-Key` twice at once: one sale, one 201 and one 200 with the same id, stock decremented once. Task 19.
5. HTML in product, customer and cashier names is shown escaped on every page and in the POS result list. Tasks 14 and 20.

## Differences from spec section 5.2

Added: `config/session.js`, `app/http/support/{wantsJson,pagination,requestMeta,returnTo}.js`, `app/services/catalog/pricing.js`, `app/services/sales/{scope,filterOptions}.js`, `public/js/{pos,pos-cart}.js`, `scripts/check-views.mjs`, `tests/helpers/{db,factories,http}.js`. One template `views/pages/errors/error.xian` serves the 403, 404 and 500 pages. Task order differs from the spec's commit list because the seed needs the password helper and the sales pages need test fixtures.

---

### Task 1: Environment, database client, test harness

**Files:**
- Create: `database/client.js`, `tests/helpers/db.js`, `tests/unit/db/client.spec.js`, `.env.test.example`
- Modify: `database/database.js`, `drizzle.config.js`, `.env.example`, `.gitignore`, `package.json`, `bin/test.js`
- Delete: `tests/unit/maths.spec.js`, `tests/feature/products/getProducts.spec.js`, `tests/browser/browser.spec.js`
- Local only, never staged: `.env`, `.env.test`

**Interfaces:**
- Produces: `database/client.js` exports `pool` (mysql2 promise pool), `db` (Drizzle on `pool` with `relations` and `casing: "snake_case"`), `closeDb(): Promise<void>`. `tests/helpers/db.js` exports `assertTestDatabase(): void` (throws unless `MYSQL_DATABASE` ends in `_test`) and `resetDatabase(): Promise<void>` (guard, then `TRUNCATE` every base table with `FOREIGN_KEY_CHECKS=0`). Scripts: `db:push` (`drizzle-kit push`), `db:push:test` (`node --env-file=.env.test node_modules/drizzle-kit/bin.cjs push`), `test` (`node bin/test.js`). `bin/test.js` sets `process.env.TEST_BASE_URL`.
- Environment names: `MYSQL_HOST MYSQL_PORT MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD APP_TIMEZONE EXPIRY_BUFFER_DAYS REGISTER_VARIANCE_THRESHOLD SESSION_COOKIE_SECURE TRUST_PROXY SEED_PASSWORD DRIZZLE_STRICT`.

- [ ] **Step 1: Install dependencies.** Run `npm ci --ignore-scripts` (skips Electron's binary download). Verify `node -e "import('argon2').then(m=>console.log(typeof m.hash))"` prints `function`; if the native binding is missing, run `npm rebuild argon2`.
- [ ] **Step 2: Start a throwaway MySQL (nothing here is committed).** Initialise with `C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysqld.exe --initialize-insecure --datadir=<scratchpad>\mysql-data --console`, then run it in the background with `--datadir=<scratchpad>\mysql-data --port=3317 --bind-address=127.0.0.1 --mysqlx=OFF --console`. With the bundled `mysql.exe -uroot -h127.0.0.1 -P3317` create databases `pharma_vault_dev` and `pharma_vault_test`. Write `.env` (dev database) and `.env.test` (test database, `DRIZZLE_STRICT=false`), both with host `127.0.0.1`, port `3317`, user `root`, empty password, `SECRET_KEY=local-dev-secret`. Expected: `select version()` prints `8.4.3`.
- [ ] **Step 3: Rework the harness.** `bin/test.js`: load `.env.test` with dotenv `override: true`, set `NODE_ENV=test`, then dynamically import `src/app.js`, `await bootstrap()`, `listen(0)` and publish the URL as `TEST_BASE_URL`. Suites `unit` (`tests/unit/**/*.spec.js`) and `feature` (`tests/feature/**/*.spec.js`); drop the browser suite and `browserClient`; keep `expect()`; `apiClient(process.env.TEST_BASE_URL)`; `forceExit: true`; a teardown hook that closes the server and calls `closeDb()` (`forceExit` alone is enough if the installed Japa has no such hook). Delete the three placeholder specs. Add `.env.test` to `.gitignore`. Create `tests/helpers/db.js`.
- [ ] **Step 4: Write the failing tests** in `tests/unit/db/client.spec.js`:

```js
test("connects to the test database", ...)       // SELECT DATABASE() AS v → value ends with "_test"
test("sessions run in UTC", ...)                  // SELECT @@session.time_zone AS v → "+00:00"
test("DECIMAL arrives as a string", ...)          // SELECT CAST(1.5 AS DECIMAL(10,2)) AS v → "1.50"
test("assertTestDatabase refuses other databases", ...) // MYSQL_DATABASE="pharma_vault_dev" → throws /_test/
```

- [ ] **Step 5: Run `npm test -- --files=client`.** Expected: FAIL (cannot find `database/client.js`).
- [ ] **Step 6: Implement.** `database/client.js`: one `mysql2/promise` pool (`waitForConnections: true`, `connectionLimit: 10`, `timezone: "Z"`, `charset: "utf8mb4"`, host, port, user, password, database from `MYSQL_*`); `pool.pool.on("connection", conn => conn.query("SET time_zone = '+00:00'"))`; `db = drizzle({ client: pool, relations, casing: "snake_case" })`. `database/database.js` becomes `export { db, pool, closeDb } from "./client.js"`. `drizzle.config.js`: `dbCredentials` from `MYSQL_*` (port as number), `strict: process.env.DRIZZLE_STRICT !== "false"`. Add every environment name above to `.env.example`; create `.env.test.example` (`NODE_ENV=test`, a `xianfire_database_test` database, `DRIZZLE_STRICT=false`).
- [ ] **Step 7: Run `npm test -- --files=client`.** Expected: PASS (4 tests).
- [ ] **Step 8: Commit.** `git add database drizzle.config.js .env.example .env.test.example .gitignore package.json bin tests` then commit `feat(db): pooled Drizzle client, env config and test harness`.

---

### Task 2: Drizzle capability canary and schema push

**Files:**
- Create: `tests/feature/db/drizzleCanary.spec.js`
- Modify (only if push needs it): `drizzle.config.js`

**Interfaces:**
- Consumes: Task 1 `db`, `pool`, `resetDatabase`.
- Produces: the pushed test schema (37 tables, plus the 2 views unless the fallback below applies; the purchasing tables from the workflow doc are not modeled), and a header comment in the canary file recording the exact call form of each Drizzle feature that later tasks must reuse.

- [ ] **Step 1: Push the schema.** Run `npm run db:push:test`. Expected: exits 0 without prompting; `SHOW FULL TABLES` in `pharma_vault_test` lists 37 base tables. If `node_modules/drizzle-kit/bin.cjs` does not exist, point the `db:push:test` script at the file that `node_modules/.bin/drizzle-kit` resolves to. If it prompts, check `DRIZZLE_STRICT` reaches `drizzle.config.js`. If the views break the push, set `schema` to an explicit list of model files excluding `inventory-views.js` and `relations/` (no service uses the views) and re-run.
- [ ] **Step 2: Write the canary tests** (with `resetDatabase` before each test):

```js
test("relational query: object where and nested with", ...)  // cashRegisters.findFirst({ where: { id }, with: { branch: true } }) → branch.code === "CAN"
test("select for update and for share inside READ COMMITTED", ...) // db.transaction(fn, { isolationLevel: "read committed" }); tx.select().from(branches).where(...).for("update"); then .for("share"); SELECT @@transaction_isolation → "READ-COMMITTED"
test("insert on duplicate key update with a raw expression", ...)  // branches.code unique; second insert sets name = CONCAT(name, '!') → "Canary!"
test("DECIMAL columns are strings", ...)           // product.reorderLevel === "0.000"
test("TIMESTAMP defaults are UTC", ...)            // audit_logs.createdAt within 5 s of Date.now()
test("DATE columns come back as a Date at UTC midnight", ...) // customers.birthDate "1990-05-17" → toISOString().slice(0, 10) === "1990-05-17"
```

- [ ] **Step 3: Run `npm test -- --files=drizzleCanary`.** Expected: PASS. A failure means the installed release candidate needs a different call form: change the form in the test until it passes, and record the passing form in the header comment. Later tasks use only recorded forms. If locking reads cannot be expressed through the builder, record `tx.execute(sql\`... FOR UPDATE\`)` as the form.
- [ ] **Step 4: Commit.** `git add tests/feature/db drizzle.config.js`; `test(db): canary for the Drizzle features the services rely on`.

---

### Task 3: `product_prices` and `document_sequences` models

**Files:**
- Create: `app/models/product-prices.js`, `app/models/document-sequences.js`, `tests/feature/db/newTables.spec.js`
- Modify: `app/models/relations/relations.js` (add both tables to the schema map; `productPrices: { productUnit, branch }`; `productUnits.prices`)

**Interfaces:**
- Produces: `productPrices` (`id`, `productUnitId` FK, `branchId` nullable FK, `unitPrice DECIMAL(14,4)` with `>= 0` check, `effectiveFrom DATETIME` not null, `effectiveTo DATETIME` nullable, `isActive`, timestamps; index on `(product_unit_id, branch_id, effective_from)`) and `documentSequences` (`scope VARCHAR(100)` primary key, `lastValue INT UNSIGNED` default 0, `updatedAt`). Tests use named exports `productPrices`, `documentSequences`.

- [ ] **Step 1: Write the failing tests** in `tests/feature/db/newTables.spec.js`:

```js
test("product_prices rejects a negative price", ...)        // insert unitPrice "-1.0000" → throws
test("product_prices DATETIME round-trips as UTC", ...)    // effectiveFrom new Date("2026-11-12T03:15:00Z") → read back toISOString() === "2026-11-12T03:15:00.000Z"
test("document_sequences upsert increments", ...)          // INSERT (scope "invoice:MAIN:20261112", 1) ON DUPLICATE KEY UPDATE last_value = last_value + 1, run 3 times → lastValue 3
```

(Fixtures: a branch, a product with one unit, built with direct inserts until Task 7 adds factories.)
- [ ] **Step 2: Run `npm test -- --files=newTables`.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the two model files following the style of `app/models/sales.js`, and register them in `relations.js`.
- [ ] **Step 4: Run `npm run db:push:test`, then `npm test -- --files=newTables`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app/models tests/feature/db`; `feat(db): add product_prices and document_sequences`.

---

### Task 4: Decimal and time helpers

**Files:**
- Create: `app/services/support/decimal.js`, `app/services/support/time.js`, `tests/unit/decimal.spec.js`, `tests/unit/time.spec.js`

**Interfaces:**
- Produces, `decimal.js` (inputs are decimal strings or integers, outputs are strings, BigInt-scaled, no `Number`): `toScale(value, scale): string` (round half away from zero, zero-padded), `add(a, b)`, `sub(a, b)`, `mul(a, b)` (all exact), `div(a, b, scale): string` (rounded; `RangeError` on a zero divisor), `cmp(a, b): -1|0|1`, `sum(values: string[]): string` (`"0"` when empty), `min(a, b)`, `isDecimal(value): boolean`.
- Produces, `time.js`: `businessTimeZone(): string`, `businessOffsetMinutes(): number` (computed once from `Intl`), `businessDate(instant: Date): string` (`YYYY-MM-DD`), `startOfBusinessDay(date: string): Date`, `startOfNextBusinessDay(date: string): Date`, `addDays(date: string, n: number): string`, `eachDay(from: string, to: string): string[]`, `toDateString(value: Date|string|null): string|null` (UTC date parts).

- [ ] **Step 1: Write the failing tests.** Each line below is one `test()` asserting the stated value.

```js
// tests/unit/decimal.spec.js
add("0.10", "0.20") === "0.30";     mul("2.000", "30.0000") === "60.0000000"
toScale("1.005", 2) === "1.01";     toScale("-1.005", 2) === "-1.01";   toScale("2", 3) === "2.000"
div("100", "3", 4) === "33.3333";   div("1", "0", 2) throws RangeError
cmp("2.0", "2.00") === 0;           sum([]) === "0";   sum(["0.10", "0.20", "0.30"]) === "0.60"
isDecimal("1e3") === false;         isDecimal("-1.50") === true
// tests/unit/time.spec.js
businessOffsetMinutes() === 480
businessDate(new Date("2026-11-12T15:59:59Z")) === "2026-11-12";   businessDate(new Date("2026-11-12T16:00:00Z")) === "2026-11-13"
startOfBusinessDay("2026-11-13").toISOString() === "2026-11-12T16:00:00.000Z"
startOfNextBusinessDay("2026-11-12").toISOString() === "2026-11-12T16:00:00.000Z"
addDays("2026-11-30", 1) === "2026-12-01";   eachDay("2026-11-10", "2026-11-12").length === 3
toDateString(new Date("2027-01-31T00:00:00Z")) === "2027-01-31";   toDateString(null) === null
```

- [ ] **Step 2: Run `npm test -- --files=decimal` and `--files=time`.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both modules.** Represent a decimal as `{ int: BigInt, scale: number }` internally; `time.js` derives the offset from `Intl.DateTimeFormat(..., { timeZone: businessTimeZone() })` parts.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app/services/support tests/unit`; `feat(core): decimal and business-time helpers`.

---

### Task 5: Async handler, HTTP errors, validation helper, `RouteBuilder` fix

**Files:**
- Create: `app/http/errors.js`, `app/http/middleware/asyncHandler.js`, `app/http/requests/validate.js`, `tests/unit/routeBuilder.spec.js`, `tests/unit/httpSupport.spec.js`
- Modify: `src/RouteBuilder.js`

**Interfaces:**
- Produces: `class HttpError extends Error { constructor(status: number, code: string, message: string, details: object[] = []) }`; `class ValidationError extends HttpError { constructor(details) }` (422, `validation_failed`, "Request validation failed"); default export `asyncHandler(handler): RequestHandler` forwarding thrown errors and rejections to `next`; `parse(schema, input): data` (zod `safeParse`; failure throws `ValidationError` with `details: [{ path: "a.b", message }]`); `RouteBuilder.resource(uri, controller, { include = [], exclude = [], middleware = [] })` and `apiResource(...)` with the same options.

- [ ] **Step 1: Write the failing tests** (a fake router records `(method, uri, handlers)`):

```js
test("resource registers handlers in order with Laravel URIs", ...) // index GET /x, create GET /x/create, store POST /x, show GET /x/:id, edit GET /x/:id/edit, update PATCH /x/:id, replace PUT /x/:id, destroy DELETE /x/:id
test("apiResource omits create and edit", ...)
test("include and exclude filter; middleware precedes the handler", ...) // include ["index"] → one registration whose handlers.length === 1 + middleware.length
test("a missing controller method names the URI", ...)   // throws TypeError matching /\/x/
test("asyncHandler forwards a rejected promise and a sync throw", ...) // next called once with the error; resolved handler → next not called
test("parse returns data or throws ValidationError", ...) // invalid → status 422, code "validation_failed", details[0].path === "email"
```

- [ ] **Step 2: Run `npm test -- --files=routeBuilder` and `--files=httpSupport`.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `RouteBuilder`, reorder the route table as above, change `create` and `edit` URIs, wrap every handler (and each middleware) with `asyncHandler`, and fix the undefined `uri` in the error message by passing it into `#assignHandlers`.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/RouteBuilder.js app/http tests/unit`; `fix(routing): RouteBuilder order, create/edit URIs, async wrapping`.

---

### Task 6: Error middleware, error page, strict mode

**Files:**
- Create: `app/http/support/wantsJson.js`, `app/http/middleware/errorHandler.js`, `views/pages/errors/error.xian`, `tests/helpers/http.js`, `tests/unit/errorHandler.spec.js`, `tests/feature/errors.spec.js`
- Modify: `src/app.js` (strict mode when `NODE_ENV !== "production"`; after `registerRoutes(app)` add `app.use(notFound); app.use(errorHandler)`)

**Interfaces:**
- Produces: `wantsJson(req): boolean` (path starts with `/api/` or `req.accepts(["html","json"]) === "json"`); `notFound(req, res, next)` (forwards `HttpError(404, "not_found", "Not found")`); `errorHandler(err, req, res, next)` (JSON: the envelope, never a stack; non-`HttpError` becomes 500 `server_error` "Something went wrong" and is logged; a body-parser `entity.parse.failed` becomes `ValidationError([{ path: "body", message: "Malformed JSON" }])`; HTML: `res.status(status).render("errors/error", { pageTitle, layout: "main", status, heading, message, detail })` where `detail` is the stack outside production and `null` in production; headings: 404 "Page not found", 403 "Access denied", 401 "Sign in required", 500 "Something went wrong").
- Produces `tests/helpers/http.js`: `class TestSession` with a cookie jar and `request(method, path, { json, form, headers }): Promise<{ status, headers, text, json() }>` using `fetch` with `redirect: "manual"`; helpers `get(path, opts)`, `post(path, opts)`; `baseUrl()` returns `process.env.TEST_BASE_URL`.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/errorHandler.spec.js (fake req/res)
test("JSON request: HttpError maps to its envelope", ...)        // HttpError(409,"insufficient_stock","m",[{a:1}]) → 409 { error: { code, message, details } }
test("JSON request: unknown error is a generic 500", ...)        // body.error.code "server_error", message "Something went wrong", no "stack" key
test("HTML request in production hides the stack", ...)          // render called with errors/error and detail null
// tests/feature/errors.spec.js
test("GET /api/v1/nope is a 404 JSON envelope", ...)             // 404, error.code "not_found"
test("GET /nope with Accept text/html is a 404 page", ...)       // 404, body contains "Page not found"
test("malformed JSON body is a 422 envelope", ...)               // POST /api/v1/nope, content-type json, body "{bad" → 422 "validation_failed"
```

- [ ] **Step 2: Run `npm test -- --files=errorHandler` and `--files=errors`.** Expected: FAIL.
- [ ] **Step 3: Implement** the modules, the page (centered card: status code, heading, message, link to `/`, `detail` in a `<pre>` when present) and the `app.js` wiring.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** The 404 feature test already proves the page renders in strict mode. `git add app/http views/pages/errors src/app.js tests`; `feat(http): central error handling and error page`.

---

### Task 7: Auth services (passwords, permissions, users, audit) and factories

**Files:**
- Create: `app/services/auth/{passwords,permissions,users}.js`, `app/services/audit/auditLog.js`, `app/http/support/requestMeta.js`, `tests/helpers/factories.js`, `tests/unit/permissions.spec.js`, `tests/feature/authServices.spec.js`
- Modify: `config/cryptography.js` (coerce every option with `Number()`; add `timeCost` from `ARGON2_TIME_COST`; defaults `type 2`, `memoryCost 19456`, `timeCost 2`, `hashLength 32`, `parallelism 1`)

**Interfaces:**
- Produces: `hashPassword(plain): Promise<string>`; `verifyPassword(hash: string|null, plain): Promise<boolean>` (runs a dummy verify when `hash` is null or malformed, returns false); `PERMISSIONS` (frozen: `DASHBOARD_VIEW`, `SALES_VIEW_OWN`, `SALES_VIEW_BRANCH`, `SALES_VIEW_ALL`, `SALES_CREATE`, `REGISTER_MANAGE`, `USERS_MANAGE`, values as in Global Constraints); `ROLE_PERMISSIONS` (role name to permission names); `can(user, ...names): boolean` (any-of; false for a null user).
- `AuthUser = { id, name, email, branchId: string|null, branchCode: string|null, branchName: string|null, roles: string[], permissions: string[] }`. `findUserByEmail(email): Promise<UserRow|null>`; `loadAuthUser(userId): Promise<AuthUser|null>` (null when missing or inactive); `createUser({ name, email, password }): Promise<{ id: string }|null>` (active, no roles, no branch; null on duplicate email); `listUsers(): Promise<{ id, name, email, branchName: string|null, roles: string[], isActive: boolean }[]>`.
- `recordAudit(executor, { userId = null, branchId = null, action, entityType, entityId = null, oldValues = null, newValues = null, reason = null, ipAddress = null, userAgent = null }): Promise<void>` where `executor` is `db` or a transaction; `requestMeta(req): { ipAddress, userAgent }` (IP cut to 45 characters).
- Factories: `makeBranch({ code?, name? }): Promise<{ id, code, name }>`; `makeUser({ branchId = null, permissions = [], roleName?, email?, password = "correct horse battery", name?, isActive = true }): Promise<{ id, email, name, branchId, password }>` (creates a role with exactly those permission rows and assigns it; `password` is the plain value).

- [ ] **Step 1: Write the failing tests.**

```js
// tests/unit/permissions.spec.js
can({ permissions: ["a"] }, "a", "b") === true;   can(null, "a") === false
ROLE_PERMISSIONS.cashier equals ["dashboard.view","sales.view.own","sales.create","register.manage"]
ROLE_PERMISSIONS.admin contains all seven permission names
// tests/feature/authServices.spec.js
hashPassword("x".repeat(14)) starts with "$argon2id$";  verifyPassword(hash, same) true; wrong false; verifyPassword(null, "x") false
createUser creates an active user with no roles; a second call with the same email in another case returns null
findUserByEmail("A@X.TEST") finds the row stored as "a@x.test"
loadAuthUser returns branch fields, role names and flattened permission names; returns null for an inactive user and for an unknown id
listUsers returns role names and branchName
recordAudit stores newValues as JSON and the given userId
```

- [ ] **Step 2: Run `npm test -- --files=permissions` and `--files=authServices`.** Expected: FAIL.
- [ ] **Step 3: Implement** the modules and factories. `loadAuthUser` joins `users`, `branches`, `user_roles`, `roles`, `role_permissions`, `permissions` (two queries are fine). Catch MySQL error code `ER_DUP_ENTRY` in `createUser`.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app/services app/http/support config/cryptography.js tests`; `feat(auth): password, permission, user and audit services`.

---

### Task 8: Auth HTTP: session config, middleware, login, register, logout

**Files:**
- Create: `config/session.js`, `app/http/middleware/{loadUser,requireAuth,requirePermission}.js`, `app/http/support/returnTo.js`, `tests/unit/sessionConfig.spec.js`, `tests/unit/authMiddleware.spec.js`, `tests/feature/auth.spec.js`
- Modify: `app/http/controllers/authController.js`, `app/http/requests/auth/{loginRequest,registerRequest}.js`, `routes/web.js`, `src/app.js`, `tests/helpers/http.js`

**Interfaces:**
- Consumes: Task 5 `parse`, `HttpError`; Task 6 `wantsJson`; Task 7 services.
- Produces: `sessionOptions(env = process.env)` (cookie per Global Constraints; `secure` follows `SESSION_COOKIE_SECURE` when set; throws `Error("SECRET_KEY is required in production")`); `loadUser(req, res, next)` sets `req.user: AuthUser|null`, `res.locals.currentUser: { id, name, email, branchName, roles, permissions }|null`, `res.locals.currentPath`, and destroys the session when the user is missing or inactive; `requireAuth` (JSON 401 `unauthenticated` when `wantsJson`, otherwise store `req.session.returnTo` for GET, flash `error_msg` "Please sign in" and redirect `/login-page`); `requirePermission(...names)` (any-of; else `next(new HttpError(403, "forbidden", "You do not have access"))`); `isSafeReturnTo(url): boolean` (starts with `/`, not `//`, not `/\`); `loginRequest(body): { email, password }` (`email` valid and at most 255, `password` 1 to 128); `registerRequest(body): { name, email, password }` (name 2 to 100, valid email, password 14 to 128, untrimmed); `loginAs(user): Promise<TestSession>` in `tests/helpers/http.js`.
- Routes: `POST /login`, `POST /register`, `POST /logout` (replaces `GET /logout`), `GET /dashboard-page` behind `requireAuth`. In `src/app.js` use `sessionOptions()`, `trust proxy` from `TRUST_PROXY`, and mount `loadUser` after the flash middleware.

- [ ] **Step 1: Write the failing tests.**

```js
// sessionConfig.spec.js
sessionOptions({ NODE_ENV: "production" }) throws /SECRET_KEY/
sessionOptions({ NODE_ENV: "production", SECRET_KEY: "s" }).cookie → { httpOnly: true, sameSite: "lax", secure: true, maxAge: 28_800_000 }
sessionOptions({ NODE_ENV: "production", SECRET_KEY: "s", SESSION_COOKIE_SECURE: "false" }).cookie.secure === false
// authMiddleware.spec.js (fake req/res)
requireAuth on /api/v1/x without a session → 401 { error: { code: "unauthenticated" } };  isSafeReturnTo("//evil.com") === false, ("/sales?page=2") === true, ("/\\evil") === false
requirePermission("a")(req with permissions ["b"]) → next called with HttpError status 403
// auth.spec.js
POST /login valid → 302 /dashboard-page, sets pv.sid with HttpOnly and SameSite=Lax, audit row LOGIN_SUCCESS
POST /login wrong password, unknown email, inactive user → identical 302 to /login-page, audit row LOGIN_FAILED, no password in the audit row
GET /dashboard-page unauthenticated → 302 /login-page; after login of that user → redirected back to /dashboard-page (returnTo)
POST /logout → 302; the old cookie then gets 302 on /dashboard-page; GET /logout → 404
POST /register valid → 302 /login-page, user exists with no roles; duplicate email, 13-character password, empty body → 302 /register-page and never a 500
a user deactivated after login is logged out on the next request
```

- [ ] **Step 2: Run `npm test -- --files=sessionConfig`, `--files=authMiddleware`, `--files=auth.spec`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Login: parse, `findUserByEmail`, always `verifyPassword` (null hash when the user is missing or inactive), generic flash "Invalid email or password", `session.regenerate`, set `userId`, `recordAudit`, redirect to a safe `returnTo` or `/dashboard-page`. Register: `createUser`, audit `USER_REGISTERED`, flash success; every validation or duplicate failure flashes a generic message and redirects back. Logout: `recordAudit`, `session.destroy`, `res.clearCookie("pv.sid")`, redirect `/login-page`. Remove the `uuid` import.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add config app routes src tests`; `feat(auth): working login, register, logout and permission middleware`.

---

### Task 9: Shell views, helpers, SweetAlert2, view checker

**Files:**
- Create: `views/partials/sideNavBar.xian`, `views/partials/swal/init.xian` (copy of the skill's `assets/swal/init.xian`), `views/partials/components/{pagination,stat-card,page-header,empty-state}.xian`, `views/helpers/{eq,gt,and,or,not,can,isActive,formatDate,formatDateTime,formatNumber,badge}.js`, `scripts/check-views.mjs` (copy of the skill's checker), `app/http/controllers/dashboardController.js`, `tests/unit/viewHelpers.spec.js`, `tests/feature/shell.spec.js`
- Modify: `views/layouts/authenticated.xian`, `views/layouts/main.xian`, `views/partials/head.xian`, `views/pages/{home,dashboard}.xian`, `views/pages/auth/{login,register,forgotpassword}.xian`, `app/http/controllers/{homeController,authController}.js`, `app/http/middleware/errorHandler.js`, `routes/web.js`, `package.json` (`views:check`: `node scripts/check-views.mjs`)

**Interfaces:**
- Produces helpers: `eq(a, b)` strict equality; `gt(a, b)` numeric; `and(...)`, `or(...)`, `not(v)` (drop Handlebars' trailing `options`); `can(...names, options)` true when `options.data.root.currentUser.permissions` contains any name (false when signed out); `isActive(path, prefix)` true for the prefix itself or `prefix + "/..."`; `formatDate(value, style = "medium")` and `formatDateTime(value)` in `APP_TIMEZONE` with locale `en-PH` (empty string for invalid input); `formatNumber(value, maxDigits = 3)` trims trailing zeros (`"20.000"` prints `20`); `badge(status)` returns a `toHTML()` object with escaped text and a color per status (`COMPLETED`/`PAID`/`ACTIVE` green, `PENDING` amber, `VOIDED` gray, `REFUNDED`/`PARTIALLY_REFUNDED` blue, `FAILED` red, anything else gray).
- Partial contracts: `components/pagination` takes `pagination = { meta: { page, totalPages, total }, prevUrl, nextUrl, pages: [{ number, url, current }] }`; `components/stat-card` takes `label`, `value`, `icon`, optional `hint`; `components/page-header` takes `title`, `icon`, optional `subtitle`; `components/empty-state` takes `icon`, `title`, optional `hint`.
- `dashboardController.index` (temporary body, replaced in Task 14) renders `dashboard` with `layout: "authenticated"`. `errorHandler` HTML branch uses `layout: res.locals.currentUser ? "authenticated" : "main"`. `GET /` redirects signed-in users to `/dashboard-page`, otherwise renders `home` (real landing copy, links to `/login-page` and `/register-page`).

- [ ] **Step 1: Write the failing tests.**

```js
// viewHelpers.spec.js
eq(1, 1) true; gt("2", "1") true; and(true, 0, opts) false; or(0, "x", opts) true; not(0) true
can("a", "b", { data: { root: { currentUser: { permissions: ["b"] } } } }) true;  with currentUser null → false
isActive("/sales/123", "/sales") true;  isActive("/salesx", "/sales") false
formatDate(new Date("2026-11-12T16:00:00Z")) === "Nov 13, 2026"     // business zone
formatNumber("20.000") === "20";  formatNumber("1.500") === "1.5";  formatNumber(null) === ""
badge("<b>") html contains "&lt;b&gt;" and no raw "<b>"
// shell.spec.js
GET / signed out → 200 with href="/login-page"; signed in → 302 /dashboard-page
cashier GET /dashboard-page → 200 with links /sales and /pos-page, no /users link, a POST form action="/logout"; admin sees /users
failed login then GET /login-page shows <meta name="flash-error" content="Invalid email or password">
signed-in GET /nope → 404 inside the authenticated layout (contains the side navigation)
login, register and forgot-password pages link to /register-page, /login-page and /login-page
```

- [ ] **Step 2: Run `npm test -- --files=viewHelpers` and `--files=shell`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `head.xian` adds the SweetAlert2 `<script>` (`https://cdn.jsdelivr.net/npm/sweetalert2@11`) and `{{>swal/init}}`. `authenticated.xian` is the app shell (sidebar from `sideNavBar`, top bar showing `currentUser.name` and `branchName` guarded with `{{#if}}`, `{{{body}}}`, footer). Sidebar entries by permission: Dashboard (all signed-in users), Sales (`sales.view.*`), New sale (`sales.create`), Cash register (`register.manage`), Users (`users.manage`), plus a logout POST form. In `main.xian` fix `text-xxl` and move the style block inside `<body>`. Icons come from the skill's verified list.
- [ ] **Step 4: Run the same commands, then `npm run views:check`.** Expected: PASS; checker exits 0.
- [ ] **Step 5: Commit.** `git add views scripts app routes package.json tests`; `feat(views): authenticated shell, helpers, SweetAlert2 and view checker`.

---

### Task 10: Users page and `501` stubs

**Files:**
- Modify: `app/http/controllers/userController.js`, `app/http/controllers/auditTrailController.js`, `routes/web.js`, `views/pages/users.xian`, `views/partials/userTable.xian`
- Create: `tests/feature/users.spec.js`

**Interfaces:**
- Consumes: `listUsers`, `requireAuth`, `requirePermission`, `RouteBuilder` `middleware` option.
- Produces: `userController.index` renders `users` with `layout: "authenticated"`, `pageTitle: "Users"`, `users: { id, name, email, branchName, roles, isActive }[]`. Every other handler in both controllers responds `501` with the JSON envelope code `not_implemented`. Routes: `routeBuilder.resource("/users", userController, { include: ["index"], middleware: [requireAuth, requirePermission("users.manage")] })`; `/audit-trail` is no longer registered. The mock array and `insert.data(data)` are deleted; the table's `delete/edit` placeholder column is removed.

- [ ] **Step 1: Write the failing tests.**

```js
admin GET /users → 200 and lists a user named "<b>x</b>" as "&lt;b&gt;x&lt;/b&gt;" with its role name and branch
cashier GET /users → 403;  signed out → 302 /login-page;  GET /users/create → 404;  GET /audit-trail → 404
```

- [ ] **Step 2: Run `npm test -- --files=users.spec`.** Expected: FAIL.
- [ ] **Step 3: Implement** the controller, view and routes.
- [ ] **Step 4: Run `npm test -- --files=users.spec` and `npm run views:check`.** Expected: PASS; exit 0.
- [ ] **Step 5: Commit.** `git add app routes views tests`; `fix(users): real users page behind users.manage, 501 for unfinished handlers`.

---

### Task 11: Base seed

**Files:**
- Create: `database/seed/{index,base,catalog}.js`, `tests/feature/seedBase.spec.js`
- Modify: `package.json` (`db:seed`: `node database/seed/index.js`)

**Interfaces:**
- Consumes: `ROLE_PERMISSIONS`, `PERMISSIONS`, `hashPassword`, models.
- Produces: `seedBase(db, { password, now = new Date() }): Promise<SeedRefs>` with `SeedRefs = { branches: { main, north }, users: { admin, pharmacist, cashierMain, cashierNorth, accountant }, registers: { main, north }, products: Product[], customers: Customer[] }` (each entry is the inserted row). `runSeed(): Promise<void>` in `database/seed/index.js` (also runs when the file is executed directly): throws when `NODE_ENV=production` or when `branches` has rows (`"Database already seeded"`), reads `SEED_PASSWORD` (default printed once; at least 14 characters), calls `seedBase`.
- Data: branches `MAIN` and `NORTH`; users `admin@`, `pharmacist@`, `cashier.main@`, `accountant@` in `MAIN` and `cashier.north@` in `NORTH`, all `@pharmavault.test`; one register per branch with code `R1`; about 16 products in `catalog.js` including `PARA-500-001` (Paracetamol 500 mg Tablet, base unit tablet, strip 10, box 100, reorder level `200`, OTC) and at least 4 `PRESCRIPTION` products with `requires_prescription` true; every sellable unit has a global `product_prices` row (effective from 60 days before `now`); 2 to 3 batches per product per branch received at least 45 days before `now`, with in `MAIN` at least one ACTIVE batch already expired, one `QUARANTINED` and one `RECALLED`; `inventories.quantity_on_hand` equals the sum of that product's batch `quantity_available` per branch; 5 customers.

- [ ] **Step 1: Write the failing tests** (`resetDatabase`, then `seedBase(db, { password: "seed-password-14" })`):

```js
2 branches MAIN and NORTH; 4 roles; 7 permissions; 5 users;  every user verifies with the seed password
loadAuthUser(cashierMain.id).permissions sorted equals ["dashboard.view","register.manage","sales.create","sales.view.own"]
PARA-500-001 has units tablet(1), strip(10), box(100) and reorder level "200.000"; at least 12 products; at least 4 PRESCRIPTION
every canBeSold unit has a product_prices row;  MAIN has an expired ACTIVE batch, a QUARANTINED batch and a RECALLED batch
inventories.quantity_on_hand === sum(batch quantity_available) for every (branch, product)
runSeed() a second time rejects with "Database already seeded"
```

- [ ] **Step 2: Run `npm test -- --files=seedBase`.** Expected: FAIL.
- [ ] **Step 3: Implement** with a seeded PRNG (`mulberry32`) so output is deterministic. Insert in foreign-key order; generate ids with the models' defaults.
- [ ] **Step 4: Run `npm test -- --files=seedBase`.** Expected: PASS. Then `npm run db:push` and `npm run db:seed` against the dev database; expected: prints the accounts and password, exits 0.
- [ ] **Step 5: Commit.** `git add database package.json tests`; `feat(db): base seed with branches, roles, users, catalog and stock`.

---

### Task 12: Sales scope and query service

**Files:**
- Create: `app/services/sales/scope.js`, `app/services/sales/salesQuery.js`, `tests/unit/salesScope.spec.js`, `tests/feature/salesQuery.spec.js`
- Modify: `tests/helpers/factories.js`

**Interfaces:**
- Consumes: `AuthUser`, `HttpError`, decimal and time helpers.
- Produces: `salesScope(user): { level: "all"|"branch"|"own"|"none", branchId: string|null, userId: string }` (widest permission wins; `branch` without a user branch resolves to `none`).
- `listSales(filters, user): Promise<{ rows: SaleListItem[], total: number }>`; `getSale(id, user): Promise<SaleDetail|null>` (null outside scope); `loadSaleDetail(id): Promise<SaleDetail|null>` (unscoped); `getSummary(filters, user, { now = new Date() } = {}): Promise<SalesSummary>`.
- `ListFilters = { page, perPage, status?: string[], branchId?, cashierId?, from?, to?, paymentMethod?, q?, sort }` with `sort` one of `transactionDate`, `-transactionDate`, `totalAmount`, `-totalAmount`, `invoiceNumber`, `-invoiceNumber`. `SummaryFilters = { from?, to?, branchId?, cashierId? }` (default range: the last 30 business days ending on `businessDate(now)`).
- `SaleListItem = { id, invoiceNumber, status, transactionDate: Date, branch: { id, code, name }, cashier: { id, name }, customer: { id, customerNumber, name }|null, register: { id, code, name }, itemCount: number, paymentMethods: string[] (sorted), totals: { subtotal, discount, tax, total, paid, change } }` (money as 2-place strings). `SaleDetail` adds `items: { id, productId, productName, genericName, unit: { id, name, abbreviation }, quantity, baseQuantity, unitPrice, discount, tax, subtotal, total, batches: { batchId, batchNumber, expirationDate: string|null, quantity }[] }[]` and `payments: { id, method, amount, reference, status, paidAt }[]`. Cost fields are never selected.
- `SalesSummary` is exactly the `data` object in spec section 8.2 (`period`, `totals`, `byDay`, `byPaymentMethod`, `topProducts`).
- Errors: a `branchId` outside the scope, or a `cashierId` other than the user's under `own`, throws `HttpError(403, "forbidden", ...)`; scope `none` throws the same.
- Factories added: `makeProduct({ branchId?, sku?, name?, classification = "OTC", requiresPrescription = false, units = [{ name: "Tablet", factor: "1", base: true, price: "10.0000" }], batches = [] })` returning `{ product, units: { id, unitId, name, factor, isBase }[], batches }` (a unit with `price` gets a global `product_prices` row effective from `2000-01-01`; each batch is `{ quantity, expirationDate = "2030-01-31", status = "ACTIVE", receivedAt = 2026-01-01T00:00:00Z, unitCost = "1.0000", batchNumber? }` and needs `branchId`, which also creates the `inventories` row with `quantity_on_hand` = sum); `makeRegister({ branchId, code? })`; `makeOpenSession({ registerId, cashierId, openingCash = "1000.00", openedAt? })`; `makeCustomer({ firstName?, lastName? })`; `makeSale({ branchId, cashierId, sessionId, transactionDate = new Date(), status = "COMPLETED", invoiceNumber?, customerId = null, lines: [{ productId, productUnitId, productName = "Test product", quantity = "1", baseQuantity = quantity, unitPrice = "10.00", batches: [{ batchId, quantity }] }], payments: [{ method = "CASH", amount, reference = null, status = "PAID" }], changeAmount = "0.00" })` returning `{ id, invoiceNumber }` (totals computed with the decimal helpers; no stock side effects).

- [ ] **Step 1: Write the failing tests.**

```js
// salesScope.spec.js
admin → "all"; accountant → "all"; pharmacist with branch → "branch"; pharmacist without branch → "none"; cashier → "own"; no sales permissions → "none"; own + all → "all"
// salesQuery.spec.js (explicit dates; never the real clock)
25 sales, perPage 10 → page 3 has 5 rows and total === 25;  page 9 → rows [] and total 25
default sort is newest first; sort "totalAmount" ascending orders by total
status ["VOIDED"] filters; paymentMethod "GCASH" returns only sales with a GCASH payment; paymentMethods is sorted and distinct
(Review Focus 1) q "%" → total 0 and q "_" → total 0 when invoices are MAIN-2026...; q "MAIN-20261112" matches by contains
(Review Focus 2) sale at 2026-11-12T16:00:00Z: from=to="2026-11-13" returns it, from=to="2026-11-12" does not; summary byDay buckets it under "2026-11-13"
scope: own returns only the cashier's sales; branch returns only that branch; branchId of another branch under "branch" → HttpError 403; cashierId of another user under "own" → 403
getSale: item batch quantities sum to baseQuantity; a customer is { id, customerNumber, name }; outside the scope → null; no key named unitCost anywhere in the JSON
summary fixtures (COMPLETED A total "180.00" paid CASH "200.00" change "20.00"; COMPLETED B total "120.00" paid CASH "20.00" + GCASH "100.00"; VOIDED C total "50.00"):
  totals.salesCount 2, grossSales "300.00", voidedCount 1, voidedTotal "50.00", refunds "0.00", netSales "300.00", averageSale "150.00"
  byPaymentMethod CASH amount "200.00" (tendered 220 minus change 20) and GCASH "100.00"; byDay lists every day of the range including empty days; topProducts ordered by revenue
a PROCESSED refund of "40.00" in range lowers netSales to "260.00"
```

- [ ] **Step 2: Run `npm test -- --files=salesScope` and `--files=salesQuery`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `listSales`: three queries (page rows with joins; item counts for the page ids; payment methods for the page ids), `LIKE` pattern escaping `\`, `%`, `_`. Date filters become `transaction_date >= startOfBusinessDay(from)` and `< startOfNextBusinessDay(to)`. Summary day buckets use `DATE(DATE_ADD(transaction_date, INTERVAL <businessOffsetMinutes()> MINUTE))`; "happened" statuses are `COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED`; cash net subtracts `SUM(sales.change_amount)` over the same sales. Satisfy `ONLY_FULL_GROUP_BY`. Detail: relational query with `with: { branch, cashier, customer, session: { with: { register } }, items: { with: { productUnit: { with: { unit } }, batches: { with: { batch } } } }, payments }`.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app/services tests`; `feat(sales): scope-aware sales query service`.

---

### Task 13: Sales API

**Files:**
- Create: `app/http/requests/sale/listSalesRequest.js`, `app/http/resources/saleResource.js`, `app/http/support/pagination.js`, `app/http/controllers/api/v1/salesController.js`, `tests/unit/pagination.spec.js`, `tests/feature/salesApi.spec.js`
- Modify: `routes/api_v1.js`

**Interfaces:**
- Consumes: Task 12 service, `parse`, `requirePermission`, `requireAuth`.
- Produces: `listSalesRequest(query): ListFilters` (defaults `page 1`, `perPage 20`, `sort "-transactionDate"`; `status` comma-separated enum; UUID checks; `from` and `to` `YYYY-MM-DD` with `from <= to`; `paymentMethod` enum; `q` at most 100 characters; unknown `sort` is a validation error); `summaryRequest(query): SummaryFilters`; `saleListResource(item)` and `saleDetailResource(detail)` (explicit key whitelists; dates as ISO strings); `paginate({ page, perPage, total, path, query }): { meta: { page, perPage, total, totalPages }, links: { self, first, prev, next, last }, prevUrl, nextUrl, pages: [{ number, url, current }] }` (links are root-relative URLs that keep the other query parameters; `prev` and `next` are `null` at the ends; `pages` shows up to 5 numbers around the current page); controller default export `{ index, show, summary }`.
- Routes (in `routes/api_v1.js`, after the public `/up` and `/health`): `router.use(requireAuth)`; `GET /sales/summary` (behind the same `requirePermission("sales.view.own", "sales.view.branch", "sales.view.all")`) registered before `routeBuilder.apiResource("/sales", salesApiController, { include: ["index", "show"], middleware: [requirePermission("sales.view.own", "sales.view.branch", "sales.view.all")] })`. A malformed `:id` answers 404 `not_found`.

- [ ] **Step 1: Write the failing tests.**

```js
// pagination.spec.js
paginate page 2 of 5 → prevUrl keeps other params with page=1, next is page=3;  page 1 → prev null;  last page → next null
// salesApi.spec.js (login as factory users; fixtures from makeSale)
GET /api/v1/sales without a session → 401 { error: { code: "unauthenticated" } };  user without sales permissions → 403 "forbidden"
cashier sees only own sales; pharmacist only their branch; accountant sees both branches
list item keys equal the spec (id, invoiceNumber, status, transactionDate, branch, cashier, customer, register, itemCount, paymentMethods, totals);  meta and links present
perPage=101 → 422 with details[0].path "perPage";  from after to → 422;  status=NOPE → 422;  sort=hacker → 422
GET /api/v1/sales/:id returns items, batches (sum === baseQuantity) and payments;  another cashier's sale → 404;  /api/v1/sales/not-a-uuid → 404
the response text contains neither "unitCost" nor "idempotency"
GET /api/v1/sales/summary → data.period spans 30 days ending on the business date of today; totals match the fixtures
```

- [ ] **Step 2: Run `npm test -- --files=pagination` and `--files=salesApi`.** Expected: FAIL.
- [ ] **Step 3: Implement** the modules and routes. Controllers call the service and never touch `db` directly.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app routes tests`; `feat(sales): sales API (list, detail, summary)`.

---

### Task 14: Dashboard and sales pages

**Files:**
- Create: `app/http/controllers/salesController.js`, `app/services/sales/filterOptions.js`, `views/pages/sales/{index,show}.xian`, `tests/feature/salesPages.spec.js`
- Modify: `app/http/controllers/dashboardController.js`, `views/pages/dashboard.xian`, `routes/web.js`

**Interfaces:**
- Consumes: Tasks 9, 12, 13 (`paginate`, `listSalesRequest`, `getSummary`, `listSales`, `getSale`, components).
- Produces: `loadFilterOptions(user): Promise<{ branches: { id, code, name }[], cashiers: { id, name }[] }>` (branches only for scope `all`, cashiers for `branch` and `all`, empty otherwise).
- `salesController.index` renders `sales/index` (`layout: "authenticated"`, `pageTitle: "Sales"`) with `sales`, `filters` (echo of every query field, empty strings when unset), `pagination`, `statusOptions`, `paymentMethodOptions`, `branches`, `cashiers`, `scopeLevel`, `filterErrors: string[]`; an invalid filter re-renders with defaults and `filterErrors`. `salesController.show` renders `sales/show` with `sale: SaleDetail` and `autoPrint: boolean` (`?print=1`); an unknown or out-of-scope id gives the 404 page. `dashboardController.index` renders `dashboard` with `hasAccess: boolean`, `today: { salesCount, grossSales }`, `daily: { date, label, grossSales, heightPct }[]` (14 business days ending today, `heightPct` 0 to 100), `paymentMix: { method, amount, pct }[]`, `recentSales: SaleListItem[]` (10), `openSession: { registerName, openedAt }|null` (`null` until Task 16 provides it), `canSell: boolean`.
- Routes: `GET /sales` and `GET /sales/:id` behind `requireAuth` and `requirePermission("sales.view.own", "sales.view.branch", "sales.view.all")`; `GET /dashboard-page` behind `requireAuth`.

- [ ] **Step 1: Load the `dataviz` skill** and follow it for the KPI tiles and the 14-day bar chart (plain HTML and Tailwind, no chart library).
- [ ] **Step 2: Write the failing tests.**

```js
cashier GET /sales → 200, lists own sales with the invoice number, links to /sales/:id, a status badge;  q filter echoed in the form;  empty result shows the empty state
GET /sales?from=2026-12-01&to=2026-11-01 → 200 with a filter error message and default results (never a 500)
cashier does not get the branch or cashier selectors; admin gets both
GET /sales/:id → 200 with items, an expandable batch row showing the batch number, payments, totals; discount and tax rows absent when "0.00"; another cashier's sale → 404 page
GET /sales/:id?print=1 contains the auto-print marker (data-auto-print="true")
dashboard: a user with only dashboard.view sees the tiles; a user with no permissions sees the "awaiting access" notice; a cashier sees the New sale button
(Review Focus 5) product, customer and cashier names set to <img src=x onerror=alert(1)> appear as &lt;img ... on the list and detail pages and never as a raw tag
```

- [ ] **Step 3: Run `npm test -- --files=salesPages`.** Expected: FAIL.
- [ ] **Step 4: Implement** the controllers and views. The detail page prints stored snapshots only and carries print CSS (`@media print` hides the shell). The filter form uses GET, date inputs with preset links (Today, Last 7 days, Last 30 days that set `from` and `to`), and the status and payment selects.
- [ ] **Step 5: Run `npm test -- --files=salesPages` and `npm run views:check`.** Expected: PASS; exit 0.
- [ ] **Step 6: Commit.** `git add app views routes tests`; `feat(sales): dashboard, sales list and receipt pages`.

---

### Task 15: FEFO allocator

**Files:**
- Create: `app/services/sales/fefo.js`, `tests/unit/fefo.spec.js`

**Interfaces:**
- Consumes: decimal helpers, `addDays`.
- Produces: `allocateFefo(batches, needed, { today, bufferDays = 0 }): { allocations: { batchId: string, quantity: string }[], shortfall: string }` where each batch is `{ id, status, quantityAvailable: string, expirationDate: string|null, receivedAt: Date|string }`, `needed` is a 3-place decimal string, quantities are 3-place strings and `shortfall` is `"0.000"` when fully allocated. Eligible: `status === "ACTIVE"`, `quantityAvailable > 0`, and `expirationDate === null` or `expirationDate >= addDays(today, bufferDays)`. Order: dated batches by `expirationDate`, then `receivedAt`, then `id`; undated batches last.

- [ ] **Step 1: Write the failing tests** (today `"2026-11-12"`):

```js
spec example: B-001 exp 2027-03-31 qty 100, B-002 exp 2027-01-31 qty 200, B-003 exp 2027-07-31 qty 150; needed "250.000" → [B-002 "200.000", B-001 "50.000"], shortfall "0.000"
expired (2026-11-11), QUARANTINED, RECALLED, DEPLETED and zero-quantity batches are skipped
a batch expiring today (2026-11-12) is eligible with bufferDays 0 and skipped with bufferDays 1
an undated batch is used only after every dated batch;  ties on expiry fall back to receivedAt then id
needed larger than the eligible total → allocates everything and shortfall is the remainder, e.g. "5.000"
needed "0.000" → no allocations
```

- [ ] **Step 2: Run `npm test -- --files=fefo`.** Expected: FAIL.
- [ ] **Step 3: Implement** as a pure function; compare dates as ISO strings.
- [ ] **Step 4: Run `npm test -- --files=fefo`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app/services/sales/fefo.js tests/unit/fefo.spec.js`; `feat(pos): pure FEFO allocator`.

---

### Task 16: Register sessions (service, page, forms)

**Files:**
- Create: `app/services/register/registerSessions.js`, `app/http/controllers/cashRegisterController.js`, `views/pages/cash-register/index.xian`, `tests/feature/registerSessions.spec.js`, `tests/feature/cashRegisterPage.spec.js`
- Modify: `routes/web.js`, `app/http/controllers/dashboardController.js` (fill `openSession`)

**Interfaces:**
- Consumes: Task 12 factories (`makeRegister`, `makeOpenSession`), `HttpError`, decimal helpers, `recordAudit`.
- Produces: `getOpenSession(userId): Promise<{ id, registerId, registerName, registerCode, openingCash, openedAt: Date }|null>`; `listOpenableRegisters(branchId): Promise<{ id, name, registerCode }[]>` (active registers of the branch with no open session); `openSession({ user, registerId, openingCash }, { now = new Date() } = {}): Promise<{ id: string }>` (409 `register_unavailable` when the register is inactive, in another branch or already open; 409 `session_exists` when the user already has one open; `ValidationError` for a negative amount); `closeSession({ user, sessionId, countedCash, note = "" }, { now = new Date() } = {}): Promise<{ status: "CLOSED"|"RECONCILIATION_REQUIRED", expectedCash, actualCash, variance }>` (403 `forbidden` for another user's session; 409 `register_closed` when not open; 422 `note_required` when `abs(variance)` exceeds `REGISTER_VARIANCE_THRESHOLD` and the note is empty); `sessionSummary(sessionId): Promise<{ openingCash, cashSales, cashIn, cashOut, cashRefunds, expectedCash, salesCount }>`.
- Behavior: open and close run in `READ COMMITTED` transactions (open locks the user row, then the register row, with `FOR UPDATE`); `expected = opening + sum(CASH_SALE) + sum(CASH_IN) - sum(CASH_OUT) - sum(CASH_REFUND)`; `variance = counted - expected`; close stores `expected_cash`, `actual_cash`, `variance`, `closed_at`, audit rows record the note.
- Routes: `GET /cash-register-page`, `POST /cash-register/open` (fields `registerId`, `openingCash`), `POST /cash-register/close` (fields `countedCash`, `note`), each behind `requireAuth` and `requirePermission("register.manage")`; success and failure both flash and redirect to `/cash-register-page`. The page renders `session`, `summary`, `registers`, `threshold` (open form when there is no session, close form otherwise).

- [ ] **Step 1: Write the failing tests.**

```js
open: stores an OPEN session with openingCash "1000.00";  second user on the same register → 409 "register_unavailable";  same user on another register → 409 "session_exists"
open rejects an inactive register, a register of another branch, and a negative amount
two simultaneous opens of the same register by different users → exactly one fulfills and one rejects 409
close: opening "1000.00" + CASH_SALE "60.00" + CASH_IN "100.00" − CASH_OUT "20.00" − CASH_REFUND "10.00" → expectedCash "1130.00"
variance exactly −"50.00" → CLOSED;  −"50.01" without a note → 422 "note_required";  with a note → RECONCILIATION_REQUIRED
another user closing → 403;  closing twice → 409 "register_closed"
page: cashier GET /cash-register-page lists the branch's registers; POST open then POST close redirect and leave the session CLOSED; an accountant gets 403
```

- [ ] **Step 2: Run `npm test -- --files=registerSessions` and `--files=cashRegisterPage`.** Expected: FAIL.
- [ ] **Step 3: Implement** the service, controller, view and routes.
- [ ] **Step 4: Run the same commands and `npm run views:check`.** Expected: PASS; exit 0.
- [ ] **Step 5: Commit.** `git add app views routes tests`; `feat(pos): register open and close`.

---

### Task 17: Pricing and product lookup

**Files:**
- Create: `app/services/catalog/{pricing,productLookup}.js`, `app/http/requests/product/productSearchRequest.js`, `app/http/resources/productResource.js`, `app/http/controllers/api/v1/productsController.js`, `tests/unit/pricing.spec.js`, `tests/feature/productLookup.spec.js`
- Modify: `routes/api_v1.js`

**Interfaces:**
- Produces: `pickPrice(rows, branchId, now): string|null` (rows `{ branchId: string|null, unitPrice, effectiveFrom: Date, effectiveTo: Date|null, isActive }`; active and effective rows only; a branch row beats a global row; the latest `effectiveFrom` wins within the same specificity; the result is a 4-place string); `loadEffectivePrices(executor, unitIds: string[], branchId, now): Promise<Map<string, string>>` (omits units without a price); `searchProducts({ q, limit = 20, branchId, now = new Date() }): Promise<ProductLookupItem[]>` with `ProductLookupItem = { id, sku, name, genericName, strength, dosageForm, classification, requiresPrescription, availableBaseQuantity, matchedUnitId: string|null, units: { productUnitId, name, abbreviation, conversionFactor, price: string|null, barcodes: string[] }[] }`; `productSearchRequest(query): { q, limit }` (`q` trimmed 1 to 100 characters, `limit` 1 to 50); `productResource(item)`; controller default export `{ index }`.
- Route: `GET /api/v1/products` behind `requirePermission("sales.create")`. Only active products with at least one active sellable unit; exact barcode match first and sets `matchedUnitId`; otherwise SKU, product, generic and brand name contains; `availableBaseQuantity` sums batches that pass the Task 15 eligibility rules using the same `today` and `EXPIRY_BUFFER_DAYS`.

- [ ] **Step 1: Write the failing tests.**

```js
// pricing.spec.js
branch row beats global; later effectiveFrom wins within the same specificity; expired (effectiveTo ≤ now), future and inactive rows are ignored; no rows → null
// productLookup.spec.js
exact barcode returns that product first with matchedUnitId set;  name, generic, brand and SKU contains match, case-insensitively
(Review Focus 1) q "%" and q "_" return nothing;  q is required (empty → 422 on the API)
an inactive product or a product without a sellable unit is hidden;  a unit without a price has price null
availableBaseQuantity ignores an expired, a QUARANTINED and a RECALLED batch and batches of another branch
limit is honored;  an accountant (no sales.create) → 403;  signed out → 401
```

- [ ] **Step 2: Run `npm test -- --files=pricing` and `--files=productLookup`.** Expected: FAIL.
- [ ] **Step 3: Implement** with set-based queries (one for products, one for units with barcodes, one for prices, one for availability). `LIKE` patterns escape `\`, `%`, `_`.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app routes tests`; `feat(pos): effective pricing and product lookup API`.

---

### Task 18: Checkout service

**Files:**
- Create: `app/services/sales/checkout.js`, `tests/feature/checkout.spec.js`

**Interfaces:**
- Consumes: Tasks 4, 7 (`recordAudit`), 15 (`allocateFefo`), 17 (`loadEffectivePrices`), 12 factories.
- Produces: `createSale(user: AuthUser, input: CheckoutInput, idempotencyKey: string, { now = new Date(), onStep }: { now?: Date, onStep?: (name: "allocated"|"sale-inserted"|"ledger-written") => void|Promise<void> } = {}): Promise<{ saleId: string, replayed: boolean }>`. `CheckoutInput = { items: { productUnitId: string, quantity: string }[], payments: { method: string, amount: string, reference: string|null }[], customerId: string|null }` (already normalized: quantities 3 places, amounts 2 places). Reads `EXPIRY_BUFFER_DAYS` at call time. Throws `HttpError` with codes `register_closed` 409, `no_price` 422, `prescription_required` 422, `payment_invalid` 422, `insufficient_stock` 409 (`details: [{ productId, requested, available }]`), `idempotency_conflict` 409, `validation_failed` 422 (unknown or inactive unit, unknown customer).
- Behavior (spec 9.4): replay lookup by key before the transaction; one `READ COMMITTED` transaction with up to 3 attempts on MySQL deadlock (`ER_LOCK_DEADLOCK`) using the same key; steps 1 to 7 in the spec in that order; invoice number `{branchCode}-{YYYYMMDD}-{seq:4}` from the business date of `now`; `sale_items.unit_cost` is the weighted average cost per selling unit (`div(total cost, quantity, 4)`); batch status becomes `DEPLETED` at zero; `inventories.quantity_on_hand` drops by the base quantity sold; `inventory_movements` rows are `SALE` with signed quantity, before and after, and the batch cost; a `CASH_SALE` cash transaction holds tendered minus change; one audit row `SALE_COMPLETED`. A product is blocked unless its classification is `OTC` and `requires_prescription` is false.

- [ ] **Step 1: Write the failing tests** (fixture: MAIN branch, cashier with an open session, product "Paracetamol 500 mg Tablet" with units Tablet factor 1 price "3.5000" and Strip factor 10 price "30.0000", one batch `quantity "1000.000"` cost "1.2000"; `now` = `2026-11-12T03:00:00Z`):

```js
2 strips + CASH "100.00" → total "60.00", change "40.00"; batch available "980.000", inventory on hand 980; one SALE movement −"20.000" before "1000.000" after "980.000" cost "1.2000"; sale_items.unit_cost "12.0000"; CASH_SALE "60.00"; invoice "MAIN-20261112-0001"; second sale "MAIN-20261112-0002"; a sale on the next business day restarts at "-0001"
split: items worth "180.00" paid CASH "100.00" + GCASH "80.00" ref "GC-1" → no change, CASH_SALE "100.00"; over-tender CASH "150.00" + GCASH "100.00" ref "GC-2" → change "70.00", CASH_SALE "80.00"
payment_invalid: CASH "100.00" for "180.00"; GCASH "200.00" alone for "180.00"; GCASH "80.00" without a reference
FEFO: batches B1 exp 2027-01-31 qty 200 (inserted last), B2 exp 2027-03-31 qty 100, B3 exp 2027-07-31 qty 150; 250 tablets → sale_item_batches B1 "200.000" + B2 "50.000" (sum === baseQuantity), B3 untouched
box unit factor 100: 2 boxes → baseQuantity "200.000";  an ACTIVE batch expired yesterday is never sold;  a batch expiring today sells; with EXPIRY_BUFFER_DAYS=1 it does not
two lines for the same product (7 + 7 tablets, 10 in stock) → 409 insufficient_stock, details { requested, available }, and nothing changed (no sale, batch qty, movements; the sequence unchanged)
Rx product → 422 prescription_required; unit without a price → 422 no_price; no open session → 409 register_closed
replay: same key twice → second { replayed: true } with the same saleId and stock decremented once; another user with the same key → 409 idempotency_conflict
rollback: onStep("ledger-written") throws → no sale, no batch change, no movement, no cash transaction, sequence not advanced
concurrency: 10 units in stock, two cashiers (own sessions, same branch) each buy 10 with Promise.all → exactly one fulfills, the other rejects 409 insufficient_stock
```

- [ ] **Step 2: Run `npm test -- --files=checkout`.** Expected: FAIL.
- [ ] **Step 3: Implement** `createSale` and an internal `postSale(tx, ctx)` holding the transactional steps. The sequence uses `INSERT ... ON DUPLICATE KEY UPDATE last_value = last_value + 1` then a read in the same transaction. Lock inventories with `.for("update")` ordered by `product_id`; select candidate batches `FOR UPDATE` filtered by branch, product, `ACTIVE`, quantity above zero and the expiry cutoff, ordered as in Task 15, then run `allocateFefo` for the authoritative decision. Use only Drizzle call forms recorded in the Task 2 canary.
- [ ] **Step 4: Run `npm test -- --files=checkout`.** Expected: PASS (including the concurrency test, run it five times).
- [ ] **Step 5: Commit.** `git add app/services/sales tests`; `feat(pos): transactional FEFO checkout`.

---

### Task 19: Checkout API

**Files:**
- Create: `app/http/requests/sale/checkoutRequest.js`, `tests/feature/checkoutApi.spec.js`
- Modify: `app/http/controllers/api/v1/salesController.js` (add `store`), `routes/api_v1.js` (`include: ["index", "show", "store"]`; `store` additionally behind `requirePermission("sales.create")`)

**Interfaces:**
- Produces: `checkoutRequest(body): CheckoutInput` (items 1 to 50, each `{ productUnitId: uuid, quantity }`; quantity a positive decimal with at most 3 places, at most 12 integer digits; payments at least 1, `method` enum, `amount` positive with at most 2 places, `reference` optional string at most 150; `customerId` optional uuid; quantities normalized to 3 places and amounts to 2). `salesController.store`: requires `req.is("application/json")` (else 422 `validation_failed`), header `Idempotency-Key` a UUID (else 422), calls `createSale`, then `loadSaleDetail`, answers `res.status(replayed ? 200 : 201).json({ data: saleDetailResource(detail) })`.

- [ ] **Step 1: Write the failing tests** (cashier with an open session and the Task 18 product):

```js
201 with the sale detail equal to GET /api/v1/sales/:id; the same Idempotency-Key again → 200 with the same id
no Idempotency-Key, or "not-a-uuid" → 422; a form-encoded body → 422; accountant → 403; signed out → 401; no open session → 409 "register_closed"
insufficient stock → 409 "insufficient_stock" with details; Rx product → 422 "prescription_required"
(Review Focus 3) each of quantity "0", "-1", "abc", "0.0001", "1e3", "99999999999999999999"; 51 lines; no payments; body "{bad" → 422 "validation_failed" and the batch quantity is unchanged
(Review Focus 4) two POSTs with the same key via Promise.all → statuses are [200, 201] in some order, both bodies carry the same id, the batch is decremented once
```

- [ ] **Step 2: Run `npm test -- --files=checkoutApi`.** Expected: FAIL.
- [ ] **Step 3: Implement** the request validator and controller action.
- [ ] **Step 4: Run `npm test -- --files=checkoutApi`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app routes tests`; `feat(pos): checkout API with idempotency`.

---

### Task 20: POS page

**Files:**
- Create: `app/http/controllers/posController.js`, `views/pages/pos/index.xian`, `public/js/pos.js`, `public/js/pos-cart.js`, `tests/unit/posCart.spec.js`, `tests/feature/posPage.spec.js`
- Modify: `routes/web.js`, `src/app.js` (`express.static(path.join(__dirname, "../public"))` instead of `process.cwd()`)

**Interfaces:**
- Consumes: `getOpenSession`, `GET /api/v1/products`, `POST /api/v1/sales`.
- Produces `public/js/pos-cart.js` (ES module, no DOM, self-contained BigInt decimals for display only): `emptyCart(): { lines: [] }`; `addLine(cart, { productUnitId, productName, unitName, price }, quantity = "1"): cart` (merges the same `productUnitId`); `setQuantity(cart, productUnitId, quantity): cart` (non-positive removes the line); `removeLine(cart, productUnitId): cart`; `cartTotals(cart): { lines: { productUnitId, subtotal }[], total }` (2-place strings, half-up); `tenderSummary(total, payments: { method, amount }[]): { tendered, change, remaining, valid }` (`valid` when tendered covers the total and non-cash does not exceed it).
- `posController.page` renders `pos/index` (`layout: "authenticated"`, `pageTitle: "New sale"`) with `session` and `config` (`{ currency: "PHP", productsUrl: "/api/v1/products", salesUrl: "/api/v1/sales" }`); no open session redirects to `/cash-register-page` with the flash "Open a register first". Route `GET /pos-page` behind `requireAuth` and `requirePermission("sales.create")`. The root element is `<div id="pos-root" data-config="{{json config}}">`; `pos.js` is loaded with `<script type="module" src="/js/pos.js">`.
- `pos.js` behavior: focus the search box on load; Enter on a barcode-shaped query adds the matched unit; results render with `textContent` only (never `innerHTML`); Rx or controlled products show a badge and a disabled add button with the reason; a unit with `price: null` is disabled; the payments panel takes method, amount, reference and shows tendered, change and remaining; Complete generates one `crypto.randomUUID()` per attempt and reuses it on retry, posts JSON with `Idempotency-Key` and `credentials: "same-origin"`; success goes to `/sales/{id}?print=1`; failure calls `xian.error(message)` and keeps the cart; a 401 shows "Session expired, sign in again" and keeps the cart; the cart persists in `sessionStorage` inside try/catch.

- [ ] **Step 1: Write the failing tests.**

```js
// posCart.spec.js
addLine twice for the same unit merges to quantity "2";  cartTotals for qty "2.5" × price "30.0000" → subtotal "75.00", total "75.00"
parity with the server helper: for (qty, price) in [("3","19.9950"),("0.333","10.0000"),("1.005","1.0000")] cartTotals equals toScale(mul(qty, price), 2) from decimal.js
tenderSummary("180.00", [CASH "200.00"]) → tendered "200.00", change "20.00", remaining "0.00", valid true;  [GCASH "200.00"] → valid false
setQuantity(cart, id, "0") removes the line
// posPage.spec.js
cashier with an open session GET /pos-page → 200 with #pos-root and data-config containing "/api/v1/products";  without a session → 302 /cash-register-page;  accountant → 403
(Review Focus 5) pos.js contains no "innerHTML" assignment of result data (read the file and assert)
```

- [ ] **Step 2: Run `npm test -- --files=posCart` and `--files=posPage`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Invoke `xian-view-engine` first. Keep Handlebars mustaches out of `pos.js` (it is a static file, not a template). Layout: search and results on the left, cart table with quantity steppers and a unit selector, totals and payments on the right; keyboard friendly; usable at phone width.
- [ ] **Step 4: Run the same commands and `npm run views:check`.** Expected: PASS; exit 0.
- [ ] **Step 5: Browser check** with the dev server (`npm start`, `.env` database seeded by Task 11): sign in as `cashier.main@pharmavault.test`, open a register, search "para", add a strip, pay cash, complete; expect the receipt page and no console errors. Fix anything found.
- [ ] **Step 6: Commit.** `git add app views public routes src tests`; `feat(pos): POS page with cart, payments and receipt redirect`.

---

### Task 21: Seed history

**Files:**
- Create: `database/seed/history.js`, `tests/feature/seedHistory.spec.js`
- Modify: `database/seed/index.js` (call `seedHistory` after `seedBase`)

**Interfaces:**
- Consumes: `createSale`, `openSession`, `closeSession`, `SeedRefs`.
- Produces: `seedHistory(db, refs, { now = new Date(), days = 30, seed = 1 }): Promise<{ sales: number }>`: for each business day from oldest to newest, each cashier opens a session at 08:00 business time, makes 3 to 8 sales through `createSale` with the clock injected (random OTC products and units, cash or split payments), and closes at 18:00 with a counted amount within ±30.00 of expected; the cashier in `MAIN` keeps today's session open.

- [ ] **Step 1: Write the failing tests** (`seedBase` then `seedHistory(..., { days: 3 })`, then SQL checks):

```js
sales exist for each of the 3 days for both cashiers;  today's MAIN cashier session is OPEN and the others CLOSED
every sale_item: sum(sale_item_batches.quantity) === base_quantity;  every sale: total_amount === subtotal − discount_amount + tax_amount and amount_paid − change_amount === total_amount
every CLOSED session: expected_cash === opening_cash + sum(CASH_SALE) and variance === actual_cash − expected_cash
for every batch: quantity_received − sum(sale_item_batches.quantity) === quantity_available
no sale item references a Rx product; no negative stock anywhere
```

- [ ] **Step 2: Run `npm test -- --files=seedHistory`.** Expected: FAIL.
- [ ] **Step 3: Implement** with the same seeded PRNG; if batch stock runs out, raise the base quantities in `catalog.js` rather than weakening checks.
- [ ] **Step 4: Run `npm test -- --files=seedHistory`, then on the dev database `npm run db:push` and `npm run db:seed`.** Expected: PASS; the seed exits 0 and prints the sale count.
- [ ] **Step 5: Commit.** `git add database tests`; `feat(db): seed 30 days of history through the real services`.

---

### Task 22: Documentation and final verification

**Files:**
- Create: `README.md` (replace the 2-byte file)
- Modify: `.env.example`, `.env.test.example` (only if values drifted)

- [ ] **Step 1: Write `README.md`:** what the project is; prerequisites (Node 24+, MySQL 8.4); setup (`npm ci`, copy `.env.example` to `.env`, create the database, `npm run db:push`, `npm run db:seed`, `npm start`); seeded accounts and the password source; the test database (`.env.test`, `npm run db:push:test`, `npm test`); the API (endpoints from spec section 8.2 and 9, error envelope, a `curl` example that signs in with a cookie jar through `POST /login` and then calls `GET /api/v1/sales`); the permission table; known limits (no CSRF token, in-memory sessions, no tax or discount, Rx blocked, manual payment confirmation).
- [ ] **Step 2: Whole-tree checks.** Run `npx oxlint`, `npx oxfmt --check` on the files this work added or changed, `npm run views:check` and `npm test`. Expected: no new lint errors, exit 0, all suites green. Fix findings.
- [ ] **Step 3: Acceptance walk-through** against spec section 14 items 1 to 11 using the seeded dev database: sign in as each role, call the API with a cookie jar, run a checkout in the POS page, print a receipt, close the register with a variance, open every page, confirm the browser console is clean at desktop and phone widths.
- [ ] **Step 4: Clean up the environment.** Stop the throwaway `mysqld`, delete its data directory, confirm `.env` and `.env.test` are untracked, and run `git status` (clean) and `git log --oneline` (the sequence of this plan, nothing pushed).
- [ ] **Step 5: Commit.** `git add README.md .env.example .env.test.example`; `docs: README with setup, seeding, testing and API usage`.
