---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
# Testing Patterns

**Analysis Date:** 2026-11-12

## Test Framework

**Runner:**
- Japa `@japa/runner` ^5.3.0 (devDependency in `package.json`)
- Config: `bin/test.js` (the runner entry point and suite definitions; there is no separate `japa.config.*` file)
- Plugins configured in `bin/test.js`:
  - `@japa/expect` ^3.0.7 — `expect()` plugin, provides `expect` on the test context
  - `@japa/api-client` ^3.2.1 — `apiClient("http://localhost:3000")`, provides `client` on the test context
  - `@japa/expect-type` ^2.0.4 — `expectTypeOf()`, type-level assertions
  - `@japa/snapshot` ^2.0.10 — `snapshot()`, snapshot assertions
  - `@japa/browser-client` ^2.3.0 — `browserClient({ runInSuites: ["browser"] })`, provides `visit` on the test context in the `browser` suite only
- Playwright `playwright` ^1.63.0 is a devDependency and is used by the browser client. Browsers must be installed separately.

**Assertion Library:**
- `@japa/expect` (Jest-style `expect(value).toBe(...)`). Also `@japa/assert` ^4.2.0 is installed but not wired into `bin/test.js`.

**Run Commands:**
```bash
npm test                      # Runs: node bin/test.js; npm run test:dep  (see note below)
node bin/test.js              # Run all suites (browser, feature, unit)
node bin/test.js --suites=unit          # Run one suite (Japa CLI flag; verify with the installed runner version)
npm run dep:check             # dependency-cruiser architecture rules over app, database, routes, tests, config, src
npm run fmt:check             # oxfmt format check
npm run lint                  # oxlint
```

**Known problem with `npm test`:** the script is `"test": "node bin/test.js; npm run test:dep"`, but no `test:dep` script exists in `package.json`. The second command fails. The closest existing script is `dep:check`.

**No watch mode and no coverage script are configured.** The `.gitignore` lists `coverage/` and `.playwright/`, `test-results/`, `blob-report/`, but nothing in `package.json` produces them.

## Test File Organization

**Location:**
- All tests live in a top-level `tests/` directory, separate from the source they test. Nothing is co-located with `app/`, `src/`, or `views/`.
- Test files are excluded from the Docker image through `.dockerignore` (`tests/`).

**Naming:**
- `*.spec.js` for all tests. The suite globs in `bin/test.js` match this suffix only.

**Structure:**
```
tests/
├── browser/
│   └── browser.spec.js              # Browser-client suite (external site)
├── feature/
│   └── products/
│       └── getProducts.spec.js      # HTTP feature test against the running server
└── unit/
    └── maths.spec.js                # Unit suite (no import of app code)
```

**Suites** (defined in `bin/test.js`):
| Suite | Glob | Timeout | Notes |
|-------|------|---------|-------|
| `browser` | `tests/browser/**/*.spec.js` | 30 s | Browser client enabled only here |
| `feature` | `tests/feature/**/*.spec.js` | default | Uses `client` against `http://localhost:3000` |
| `unit` | `tests/unit/**/*.spec.js` | default | No dependencies on app code |

## Test Structure

**Suite Organization:**
Japa uses `test.group(name, fn)` for grouping and `test(name, fn)` for cases. The unit example in `tests/unit/maths.spec.js`:
```javascript
import { test } from "@japa/runner";
test.group("Maths.add", () => {
  test("add two numbers", ({ expect }) => {
    // Test logic goes here
    expect(1 + 1).toBe(2);
  });
});
```

The feature example in `tests/feature/products/getProducts.spec.js`:
```javascript
import { test } from "@japa/runner";
test("get /products", async ({ client }) => {
  const response = await client.get("/products");

  console.log(response.body());
  console.log(response.status());
});
```

The browser example in `tests/browser/browser.spec.js` uses `visit` and page assertions (`assertPath`, `assertTextContains`) on `https://japa.dev/docs`. It is the Japa template example and does not test this application.

**Patterns:**
- Import `test` from `@japa/runner` in every spec file. Destructure `expect`, `client` or `visit` from the test context argument.
- Use `test.group(...)` to group related cases. The only group is in the unit spec.
- Setup and teardown hooks: none present. Japa supports `test.group((group) => { group.setup(...); group.teardown(...); })` and `group.each.setup(...)`; use these when database or server state is needed.
- Assertion pattern: `expect(actual).toBe(expected)`. Use `toEqual`, `toMatchObject`, `toHaveProperty` etc. from `@japa/expect` (Jest-compatible API).

**Gaps in the existing examples (do not copy):**
- `getProducts.spec.js` has no assertions. It logs the body and status and passes whenever the request does not throw. No `/products` route exists in `routes/web.js` or `routes/api_v1.js`, so the request returns 404 and the test still passes.
- `maths.spec.js` asserts `1 + 1 === 2` and imports nothing from the project. It does not test any code. The group name `Maths.add` refers to a module that does not exist.
- `browser.spec.js` depends on the public internet and on `japa.dev`, not on this app.

## Mocking

**Framework:** None. No mocking library (`sinon`, `vitest`, `jest`, `nock`) is in `package.json`. Node's built-in `node:test` mocks are not used.

**Patterns:**
- No mocks are present in the codebase. The existing tests call real HTTP (`client`) or real external sites (`visit`).
- Japa's `@japa/file-system` ^3.0.0 is installed (devDependency) but not wired in `bin/test.js` and not used in any spec.

**What to Mock (recommended for new tests):**
- Database access: the module `database/database.js` builds a MySQL connection at import time (`drizzle(mysqlUrl, { relations })`). Importing it in a unit test opens a connection attempt. Inject a fake client or split the connection into a factory before writing unit tests against controllers or models.
- Session and request objects for controllers: build plain `{ body, params, session }` objects and a `res` double with `render`, `redirect`, `json`, `status` and `send` as `vi.fn`-style spies (use simple closures, there is no spy library).
- Xian engine: `createXianEngine` takes directories as options, so tests can pass a temporary directory fixture with a small `.xian` template.

**What NOT to Mock:**
- Zod validators (`app/http/requests/**`). They are pure functions and should be tested directly.
- `RouteBuilder` (`src/RouteBuilder.js`). It is pure and can be tested with a stub router that records `router[method](uri, handler)` calls.
- `views/helpers/currency.js`. It is pure.

## Fixtures and Factories

**Test Data:**
- None. No fixtures directory, no factories, no seed files are used by tests.
- `drizzle-seed` ^1.0.0-rc.4 is a runtime dependency in `package.json` and could generate seed data, but no test or script imports it.
- The sample `users` list in `app/http/controllers/userController.js` is hardcoded in the controller, not in a fixture.

**Location:**
- No fixture location is defined. If fixtures are added, use `tests/fixtures/` and register it in the `unit`/`feature` suites.

**Database for tests:**
- No test database is configured. `database/database.js` reads `PROD_MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_NAME`, while `.env.example` defines `MYSQL_USER`, `MYSQL_DATABASE`, not the `PROD_` variant or `MYSQL_NAME`. This mismatch must be resolved before any test touches the database.
- `drizzle.config.js` hardcodes `host: "localhost"`, `user: "root"`, `database: "mysql"`. Do not reuse these in tests.

## Coverage

**Requirements:** None enforced. No coverage threshold, no `c8`/`nyc`/`@vitest/coverage` configuration.

**View Coverage:**
```bash
# Not configured. To add coverage, install a provider (for example c8) and add a script.
```

## Test Types

**Unit Tests:**
- Directory: `tests/unit/`. One placeholder spec exists (`tests/unit/maths.spec.js`) that tests nothing from the project.
- Recommended scope: pure modules with no I/O:
  - `app/http/requests/**/*.js` (Zod validators)
  - `src/RouteBuilder.js`
  - `src/xian/errors.js`, `src/xian/helpers.js` (`createHelperName` is not exported, test through `registerHelpers`)
  - `views/helpers/*.js` (`currency`, `json`, `uppercase`)
  - `src/scripts/utils.js` (`toPascalCase`, `toCamelCase`, `ensureDir`)
  - `app/models/helpers/uuid.js`

**Integration Tests:**
- Directory: `tests/feature/`. One spec exists (`tests/feature/products/getProducts.spec.js`) and it targets a route that does not exist.
- Requires the server running on port 3000 (`npm start` or `npm run xian`). `apiClient("http://localhost:3000")` in `bin/test.js` is the base URL. The server is not started automatically.
- Recommended scope: routes in `routes/web.js` (`/login`, `/register`, `/dashboard-page`, `/users`, `/audit-trail`) and `routes/api_v1.js` (`/api/v1/up`, `/api/v1/health`). The health endpoints are the simplest to assert against and need no database.
- The `src/xian/` engine can be exercised with `createXianEngine` directly against a temporary views directory (see Mocking).

**E2E Tests:**
- Browser suite: `tests/browser/` with `@japa/browser-client` and Playwright. It is currently pointed at `https://japa.dev/docs`, not this app.
- Recommended: point `visit` at `http://localhost:3000/login-page` and assert on page elements. This requires a running server and Playwright browsers installed (`npx playwright install`).
- The `.gitignore` already excludes `.playwright/`, `test-results/` and `blob-report/`.

## Areas With No Tests

Nothing under these paths has a meaningful test:
- `app/http/controllers/` — `authController.js` (login is incomplete, `user` and `match` are undefined; register references undefined `password` and `product`), `userController.js` (`index` calls `insert.data(data)` which throws), `homeController.js`, `auditTrailController.js` (all handlers empty), `api/v1/healthController.js`
- `app/http/requests/` — `loginRequest.js`, `registerRequest.js` (calls `.trim()` on possibly missing body fields), `singleResourceRequest.js` (uses `z` without importing it), `user/*.js` (empty stubs)
- `app/http/middleware/requestLoggerMiddleware.js` (empty file)
- `app/models/**` — 40+ Drizzle table definitions and `inventory-views.js`; no schema or relation tests
- `database/` — `database.js` connects on import; `migrations/` (SQL plus `schema.ts`, `relations.ts`)
- `src/xian/` — `engine.js`, `partials.js`, `layouts.js`, `watcher.js`, `helpers.js`, `errors.js`
- `src/RouteBuilder.js` — incomplete (`//! WIP...`)
- `src/scripts/` — generators and `route-cache.js` (which writes into `middleware/` and `controllers/`)
- `views/` — all `.xian` templates; `views/helpers/currency.js` has no test even though it is pure
- `config/cryptography.js` — `argon2Config` reads env vars without parsing (strings passed where numbers are expected)

Priority for first tests (highest risk, lowest setup cost):
1. `app/http/requests/**` validators — pure, security-relevant (login, registration).
2. `src/xian/engine.js` error path (`XianTemplateError` with line/column).
3. `/api/v1/up` and `/api/v1/health` feature tests (no DB needed).
4. Auth flow (`/login`, `/register`, `/logout`) once `authController.js` is completed.

## Common Patterns

**Async Testing:**
```javascript
import { test } from "@japa/runner";

test("GET /api/v1/up responds with 200", async ({ client, expect }) => {
  const response = await client.get("/api/v1/up");
  expect(response.status()).toBe(200);
});
```
Japa awaits async test functions. The `client` is pre-configured with the `apiClient` base URL from `bin/test.js`.

**Error Testing:**
```javascript
import { test } from "@japa/runner";
import { loginRequest } from "../../app/http/requests/auth/loginRequest.js";

test.group("loginRequest", () => {
  test("returns Zod issues when password is missing", ({ expect }) => {
    const req = { body: { email: "a@b.c" } };
    const result = loginRequest(req);
    expect(Array.isArray(result)).toBe(true);
  });
});
```
Note: `loginRequest` returns `error.issues` (an array) on failure and returns `undefined` for any non-Zod error. If `registerRequest` is tested, its failure shape is `{ error: [...] }`. Pick one shape before writing these tests (see CONVENTIONS.md).

**Snapshot and type tests:**
- `snapshot()` and `expectTypeOf()` are registered in `bin/test.js` but not used. Use `expectTypeOf` only where JSDoc types are meaningful; this project has no TypeScript compilation step for `.js` files.

## Architecture Rule Tests

`dependency-cruiser` (`.dependency-cruiser.cjs`, run by `npm run dep:check`) enforces structural rules, not behaviour. Relevant rules:
- `no-circular` — error on circular module dependencies
- `not-to-test` / `not-to-spec` — production code must not import test files
- `not-to-dev-dep` — production code must not import devDependencies
- Required rules at the bottom of the file (`model - sequelize Datatypes`, `model - database/database.js`, `http/request - zod`) are copy-pasted from a template: the `http/request - zod` rule checks `app/models` → `database/database.js`, which does not describe what its name says. Fix before relying on it.
- The file header reads `generated: dependency-cruiser@17.4.3 on 2026-09-20`.

---

*Testing analysis: 2026-11-12*
