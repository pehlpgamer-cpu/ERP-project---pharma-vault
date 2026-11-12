---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
# Codebase Concerns

**Analysis Date:** 2026-11-12

Static analysis only. No dependencies were installed, the app was not run, and tests were not executed. Line numbers refer to the working tree as found on disk. `electron/main.js` is deleted in the working tree and is treated as absent.

## Severity Summary

| Severity | Count | Headline |
| --- | --- | --- |
| Critical | 5 | Login and registration cannot work and can crash the process; the user list is public; no database access exists in the request path; secrets fall back to defaults |
| High | 6 | No CSRF protection; no rate limiting; password hashing is incomplete; schema and models disagree; Docker production image runs the wrong entry point; the `migrate` tooling is missing |
| Medium | 8 | Dead links and redirects; RouteBuilder shadowing; hanging handlers; template XSS surface; missing test coverage; dependency bloat |
| Low | 5 | Stale docs, unused files, cosmetic CSS issues, and leftover scaffolding |

---

## Critical

### Login handler references undefined variables and cannot succeed

**Issue:** `authController.login` uses `user` and `match`, which are never declared. The password check is commented out.
- Files: `app/http/controllers/authController.js` (lines 21, 24, 25, 26)
- Symptom: every `POST /login` throws `ReferenceError: user is not defined`. The `login` function is `async`, and Express 4 does not catch rejected promises from async handlers.
- Impact: Node 15+ treats an unhandled promise rejection as fatal by default, so a single bad login request can crash the server. Even if the crash is avoided, no session is ever created, so authentication is non-functional.
- Fix approach: query the user by email (Drizzle, the `users` model), verify with `argon2.verify`, call `req.session.regenerate` before setting `req.session.userId`, and wrap async handlers with a try/catch or an async-wrapper that forwards to `next(err)`. Upgrade to Express 5 or add `express-async-errors`-style handling globally.

### Registration handler references undefined variables and never persists a user

**Issue:** `authController.register` hashes `password`, which is never declared (only `validData` exists). It never inserts anything and never responds.
- Files: `app/http/controllers/authController.js` (lines 34–43, especially line 39)
- Symptom: `ReferenceError: password is not defined`; the request also hangs if the error were caught, because no response is sent.
- Also: `registerRequest` (`app/http/requests/auth/registerRequest.js` lines 33–35) calls `req.body.name.trim()`. If `name`, `email`, or `password` is missing from the body, that throws a `TypeError` before any validation runs, which crashes the process the same way.
- Fix approach: validate first, then hash with a salt, insert the user, and redirect with a flash message.

### Public user listing with hard-coded mock data and an undefined reference

**Issue:** `GET /users` is mounted with no authentication and renders a hard-coded array of four users. The first statement, `insert.data(data)`, references undefined `insert` and `data`.
- Files: `app/http/controllers/userController.js` (lines 14–18, 19–44, 47–51); route at `routes/web.js` line 23
- Symptom: `ReferenceError: insert is not defined` on every request. If that line is removed, the page shows fake data including usernames and email-like strings.
- Impact: any visitor can reach the user index. Once real data is wired in, this becomes a PII exposure path.
- Fix approach: remove the mock and the bad line, add an auth guard (see the High section), and query users through Drizzle.

### No database access is wired into the running application

**Issue:** The request path never imports a database client. `database/database.js` builds a Drizzle MySQL client but never exports it. Its `mysqlUrl` uses `PROD_MYSQL_USER`, which no other file defines. It also imports `relations` without a `.js` extension, which fails under `"type": "module"`.
- Files: `database/database.js` (lines 1–12, no export); `app/models/*.js` (not imported by any controller)
- Impact: the ERP domain (products, sales, inventory, prescriptions, audit trail) has schema definitions but no working data path. Every "list" page is static.
- Fix approach: create a single `database/client.js` that exports a configured Drizzle instance, read config from `MYSQL_*` variables consistently, and inject it into controllers.

### Secrets and credentials fall back to hard-coded defaults

**Issue:** several paths use a fallback secret or a literal credential:
- `src/app.js` line 37: session secret falls back to the literal `"development-secret"` when `SECRET_KEY` is unset. This also applies in production because nothing prevents it.
- `app/http/controllers/authController.js` line 38: the password pepper is `process.env.SECRET_KEY` with no fallback. When the variable is unset, the string concatenation produces `...undefined`, which silently weakens or breaks hashing.
- `drizzle.config.js` lines 12–18: `dbCredentials` hard-codes host, user `root`, and a literal password (the value is on line 16; not reproduced here).
- `.env.example` lines 4 and 7–10 contain example secrets. They are placeholders, but they are committed and are the values developers will copy.
- `Dockerfile.prod` runs with `NODE_ENV=production` but nothing enforces that `SECRET_KEY` is set.

Fix approach: fail startup when `SECRET_KEY` or database credentials are missing in production. Remove the literal password from `drizzle.config.js` and read it from the environment. Rotate any credential that was ever used outside a local container.

---

## High

### No CSRF protection on state-changing forms

**Issue:** `login.xian` (line 2), `register.xian` (line 2) and the logout link use plain `POST` forms with no token. No CSRF middleware is installed in `src/app.js`.
- Files: `src/app.js` (middleware stack lines 25–50); `views/pages/auth/login.xian`; `views/pages/auth/register.xian`
- Impact: a third-party page can submit login and registration on a user's behalf. Combined with the logout link being a GET (`routes/web.js` line 20), a cross-site image tag can log users out.
- Fix approach: add `csurf`-equivalent middleware (for example `csrf-sync` or `csrf-csrf`), embed a token in every form and in `fetch` calls, and move logout to `POST`.

### Session and cookie hardening is missing

**Issue:** `src/app.js` lines 35–41 configure `express-session` with no cookie options.
- `cookie.secure` is not set, so cookies travel over plain HTTP in any non-TLS deployment.
- `sameSite` is not set, which weakens CSRF defenses.
- The default `MemoryStore` is used. It leaks memory, does not survive restarts, and does not work across multiple containers.
- `authController.login` (when fixed) sets `req.session.userId` without `req.session.regenerate`, which enables session fixation.
- `logout` (`authController.js` lines 45–48) calls `req.session.destroy()` without a callback and does not clear the cookie.
- No `trust proxy` setting exists, so `secure` cookies would not work behind a reverse proxy.

Fix approach: set `cookie: { httpOnly: true, secure: NODE_ENV === "production", sameSite: "lax" }`, use a Redis or MySQL session store (Redis is already in `compose.dev.yaml`), regenerate on login, and destroy then clear the cookie on logout.

### No authentication or authorization on any protected route

**Issue:** `app/http/controllers/authController.js` line 15–18 checks `req.session.userId` only inside `dashboardPage`. No reusable middleware exists. `/users` and `/audit-trail` (`routes/web.js` lines 23–24) and every `/api/v1/*` route are open.
- Files: `routes/web.js`, `routes/api_v1.js`, `app/http/controllers/userController.js`, `app/http/controllers/auditTrailController.js`
- Impact: once the data layer exists, every ERP resource is readable and writable without login. There are no roles or permissions in the code, even though `app/models/roles.js`, `permissions.js`, `user-roles.js`, and `role-permissions.js` define them.
- Fix approach: add `requireAuth` middleware and a role/permission check. Apply it at the router level before `routeBuilder.resource` calls.

### Password hashing is incomplete and salt cannot be verified

**Issue:** the register path intends `argon2.hash(password + salt + pepper)` where `salt = uuidv4()` (`authController.js` lines 37–39). The salt is never stored, and the `users` model has no `salt` column (`app/models/users.js` lines 6–19). Login cannot reproduce the hash.
- Also, the `argon2` library handles its own salt. A manual salt is redundant. Concatenating a pepper with the password is an unusual construction that should be replaced with a documented HMAC step, or dropped.
- `config/cryptography.js` lines 1–6 pass environment values as strings (for example `memoryCost: "19456"`). `argon2` expects numbers, so coerce with `Number()`. `hashLength` defaults to 50 here but `.env.example` line 30 says 32. `ARGON2_TIME_COST` (`.env.example` line 27) is never read.
- Also: `bcrypt` (`package.json` line 38) is installed but unused, which leaves two hashing libraries in the tree.

Fix approach: use `argon2.hash(password, { type: argon2.argon2id, ... })` with no manual salt or pepper, store the full encoded hash in `users.password`, and verify with `argon2.verify`. Remove `bcrypt`.

### Schema, models, and migrations disagree

**Issue:** the only migration SQL describes a different database from the Drizzle models.
- `database/migrations/20260926061918_tan_rattler/migration.sql` creates `users` with `id int AUTO_INCREMENT`, `username`, `salt`, `role_id int`, and soft-delete `deleted_at`. The model at `app/models/users.js` uses `id char(36)` UUID, `name`, `branch_id`, `employee_number`, `is_active`, and `remember_token`. There is no `salt` column in the model.
- `roles` is `int` plus `role` in the migration and `char(36)` plus `name` in `app/models/roles.js`.
- `database/migrations/20260926024159_steep_nico_minoru/migration.sql` creates `users_table` and then drops it in the second migration, so migration history is contradictory.
- `database/migrations/schema.ts` (516 lines) is an introspection dump of MySQL's own `mysql` system schema (`innodb_index_stats`, `columns_priv`, `db`, `general_log`, `global_grants`, and so on). It was not written by the app. Line 35 is invalid TypeScript: `'set('select','insert','update','references')'` has unescaped quotes.
- `database/migrations/relations.ts` imports `./schema` and is TypeScript, but the project has no TypeScript dependency or build step (`package.json` has no `typescript`).
- `drizzle.config.js` points `out` at `./database/migrations` and `schema` at `./app/models`. Running `drizzle-kit generate` would therefore add a third set of files to a directory that already contains conflicting history.

Fix approach: delete `database/migrations/schema.ts` and `relations.ts` (or move them out of the migrations folder), regenerate a single baseline migration from `app/models`, and document that migrations are authoritative. Pick UUID or INT for keys and apply it everywhere.

### Dockerfile.prod runs the wrong entry point

**Issue:** `Dockerfile.prod` line 18 is `CMD ["node", "src/app.js"]`. `src/app.js` builds the Express app and exports `bootstrap`, but it never calls `bootstrap()` and never calls `app.listen`. The container therefore starts, exits cleanly, and serves nothing. `src/server.js` is the real entry point (`package.json` line 11).
- Also: `Dockerfile.prod` copies `.` with `COPY --chown=node:node . .` (line 12). `.dockerignore` does not exclude `.claude/`, `.planning/`, or `.vscode/`, so local tooling state and the IDE settings are baked into the image.
- The image has no `HEALTHCHECK`, although `GET /api/v1/up` exists (`routes/api_v1.js` line 6).
- `compose.prod.yaml` declares `backend:`, `mysql:`, and `redis:` with no image, build, or configuration (the whole file is 68 bytes of empty keys). Production deployment is not defined.

Fix approach: change CMD to `["node", "src/server.js"]`, add a `HEALTHCHECK` against `/api/v1/up`, and tighten `.dockerignore`. Write a real `compose.prod.yaml` or remove it.

### Dangling references in package.json, CLI, and devcontainer

**Issue:** after `electron/main.js` was deleted, several references still point to it or to files that do not exist.
- `package.json` line 9 sets `"main": "electron/main.js"`. Lines 21–25 define `electron`, `dev:electron`, `build`, `run`, and `dist` scripts that depend on Electron.
- `package.json` line 24: `run` executes `nodemon index.js`, and `index.js` does not exist.
- `package.json` lines 13–15: `migrate`, `migrate:fresh`, and `migrate:drop` reference `src/scripts/migrate/*.js`. That directory does not exist.
- `package.json` line 30: `test` runs `node bin/test.js; npm run test:dep`, and no `test:dep` script is defined.
- `package.json` line 22: `dev:electron` uses `npm run dev`, which is not defined either.
- `bin/xian.js` lines 14–29 map `dev`, `test:watch`, and `test:coverage` to scripts that do not exist. Its help text (lines 50, 54) advertises "Jest tests" and "Electron", though the project uses Japa.
- `.dockerignore` line 48 excludes `electron/`, which is harmless now but should be cleaned up.
- `.devcontainer/devcontainer.json` runs `npm ci` on create, which will install `electron@28` (a large binary download) for no reason.

Fix approach: remove the Electron scripts and `main`, delete `electron-builder` and `electron` from devDependencies, and fix the script names to match files that exist.

---

## Medium

### Auth links and redirects point to routes that do not exist

**Issue:** the app only serves `*-page` GET routes, but several links and redirects use bare paths.
- `views/pages/auth/login.xian` line 7: `href="/register"`. `POST /register` exists, but `GET /register` does not.
- `views/pages/auth/register.xian` line 8: `href="/login"`. Not a GET route.
- `views/pages/auth/forgotpassword.xian` line 4: `href="/login"`. Not a GET route.
- `app/http/controllers/authController.js` line 16 redirects to `/login`, line 31 to `/dashboard`, and line 47 to `/login`. None of these are routes (`routes/web.js` defines `/login-page` and `/dashboard-page`).
- Impact: after logout, the user lands on a 404.

Fix approach: change the links to `/login-page` and `/register-page`, and change the redirects to match.

### RouteBuilder.resource shadows create and edit

**Issue:** `src/RouteBuilder.js` lines 10–54 register handlers in the order `index, show, store, update, replace, destroy, create, edit`. `index` and `create` both use `GET /users`, so `create` is never reached. `show` and `edit` both use `GET /users/:id`, so `edit` is never reached.
- Files: `src/RouteBuilder.js` (lines 12–15, 47–50); `routes/web.js` lines 23–24
- Impact: `userController.create` and `userController.edit` are dead code. The `/audit-trail` resource has the same issue.
- Fix approach: register `create` and `edit` page routes explicitly (`/users/create`, `/users/:id/edit`) before calling `resource()`, and exclude them from `resource()`.

### Handlers that never respond leave requests hanging

**Issue:** many controller methods are empty or return nothing, so the HTTP request never completes.
- `app/http/controllers/userController.js`: `update` (line 60–62), `replace` (line 63), `destroy` (line 65), `show` (lines 7–11, returns `{}` but does not `res.json` a real result), `store` (line 57, also references undefined `product`).
- `app/http/controllers/auditTrailController.js` lines 10–42: all eight handlers are empty comments.
- `app/http/requests/user/storeUserRequest.js` and `updateUserRequest.js`: default-export stubs (`export default () => {}`), so the validators do nothing.
- `app/http/requests/singleResourceRequest.js` uses `z.int()`, which is a Zod 4 API and returns the issues array on failure rather than a validated value.
- Impact: clients see timeouts. Any reverse proxy will eventually return 504.

Fix approach: return `501 Not Implemented` from unfinished handlers, or remove them from the resource until they exist.

### Input validation is partial and partly broken

**Issue:**
- `loginRequest` (`app/http/requests/auth/loginRequest.js` lines 6–25) returns `error.issues` (an array) on failure. The caller destructures `{ email, password }` from it, which yields `undefined` values without any error. Callers have no reliable way to detect failure.
- `registerRequest` (`app/http/requests/auth/registerRequest.js` lines 31–50) returns `{ error: issues }` on failure, which is a different shape from `loginRequest`. The register controller ignores the return value entirely.
- Validation rules are inconsistent: `name` must be 6 to 14 characters (line 39), which rejects most real names. `email` has `max(64)` but no format check. `password` is trimmed before length checking, so leading and trailing spaces change the stored value.
- `.trim()` on `req.body.password` silently removes intentional whitespace from passwords.
- `app/http/requests/auth/loginRequest.js` has no max length, which allows very large payloads to reach argon2 (a CPU-expensive operation).

Fix approach: use one validation pattern (throw or return `{ ok, data, errors }`), validate email format with `z.email()`, never trim passwords, and cap body size with `express.json({ limit: "10kb" })`.

### No rate limiting, brute-force protection, or account lockout

**Issue:** `POST /login` (`routes/web.js` line 18) has no rate limiter and no lockout. The API has no rate limiter either.
- Impact: unlimited password guessing once login works. The error messages (`"User not found"` vs `"Incorrect password"`, `authController.js` lines 24 and 27) also reveal which emails are registered, which is a user-enumeration vulnerability.
- Fix approach: add `express-rate-limit` on `/login` and `/register`, return a single generic message for both failure cases, and consider a lockout counter on `users`.

### Template XSS surface and unsafe patterns

**Issue:** the engine escapes `{{x}}` by default (`src/xian/engine.js` line 42, `noEscape: false`), which is good. Risk comes from the rest of the stack.
- `views/helpers/json.js` returns raw `JSON.stringify` output. Any template that uses it inside `<script>` or an unquoted attribute opens an injection path. The project skill documents this risk; check every `{{json ...}}` usage before adding one.
- `views/layouts/main.xian` line 31: `{{{body}}}` is raw output. This is the intended use, but any future caller that passes user input as the page body would be vulnerable.
- `views/partials/userTable.xian` lines 14–17 print `username`, `email`, and `role` from unvalidated source. Currently the source is hard-coded, but a database value would print as-is only because `{{ }}` escapes it. This is safe today but depends on escaping staying on.
- Tailwind and Bootstrap Icons are loaded from `cdn.jsdelivr.net` with no Subresource Integrity (`views/partials/head.xian` lines 6–7). A compromised CDN serves arbitrary script to every page.
- There is no Content Security Policy. Adding `helmet` would set CSP, `X-Frame-Options`, and `X-Content-Type-Options` in one call. None is installed (`package.json` has no `helmet`).

Fix approach: add `helmet` with a CSP that allows the specific CDN hosts, add `integrity=` and `crossorigin=` to CDN tags, and keep `{{ }}` escaping as the default for any data from the database.

### Test coverage is effectively zero

**Issue:** the tests do not exercise the application.
- `tests/unit/maths.spec.js` asserts `1 + 1 === 2`. It tests nothing in the codebase.
- `tests/feature/products/getProducts.spec.js` calls `GET /products`, which has no route (`routes/web.js` and `routes/api_v1.js` do not define it). The test only logs output and asserts nothing.
- `tests/browser/browser.spec.js` visits `https://japa.dev/docs`, an external third-party site. It is a network dependency, not a test of this app.
- `bin/test.js` line 28 points the API client at `http://localhost:3000`, which requires a running server with a database.
- Untested areas: authentication (login, register, logout, session), the Xian engine (`src/xian/*.js`), validators (`app/http/requests/*.js`), route registration (`src/RouteBuilder.js`), and every model.
- No coverage tooling is configured. The `coverage/` path is in `.gitignore` but nothing produces it.

Fix approach: add unit tests for the request validators and `RouteBuilder`, feature tests for `/login` and `/register` against a test database, and an engine test that renders each page with strict mode on. Delete the placeholder maths test.

### Unused dependencies and mixed toolchains

**Issue:** `package.json` carries packages the source does not use.
- `sequelize` (line 50) is referenced only by `src/scripts/create/model.js` line 14–15, which generates Sequelize code for a Drizzle project.
- `studio` (line 51) is not imported anywhere. Its purpose is unclear and it should be verified before anything else.
- `inquirer` (line 48), `editorconfig` (line 44), `drizzle-seed` (line 43), and `bcrypt` (line 38) are not imported. `drizzle-seed` sits in runtime dependencies.
- `jsx` (`package.json` line 69) is an unrelated npm package in devDependencies.
- `electron` (line 67, about 100 MB download) and `electron-builder` (line 68) are unused after the Electron removal (see Critical/High).
- `drizzle-orm` and `drizzle-kit` are pinned to `^1.0.0-rc.4`, a release candidate.
- `chokidar` is pinned to `^5.0.0`. Confirm it is compatible with the Node version in `engines` (`>=24`).
- Impact: a larger attack surface, slower installs, and an unclear dependency story for future developers.

Fix approach: run `npm ls` and a dependency checker, remove what is unused, and pin release candidates deliberately.

### Scaffolding generators write Sequelize code and have a wrong write path

**Issue:** the generators in `src/scripts/create/` produce code for a stack this project does not use.
- `src/scripts/create/model.js` line 14–17 generates `sequelize.define` with `import { sequelize } from "../../database/database.js"`, but `database/database.js` does not export `sequelize`.
- `src/scripts/create/request.js` line 38 writes the request file with the variable name `controllerPath`, which looks like a copy-paste error that could overwrite a controller with a request.
- `src/scripts/route-cache.js` lines 114 and 177 perform top-level `await fs.writeFile(...)` when imported, so importing it has side effects. It also writes to `middleware/`, `controllers/`, and `routes/index.js` relative to `process.cwd()`, and `routes/index.js` does not exist (the project uses `routes/routes.js`).
- Impact: running `npm run create:model` produces code that does not compile against this project.

Fix approach: rewrite the generators for Drizzle and the existing folder layout, or remove them until they are needed. Verify the `request.js` write target.

---

## Low

### Stale or misleading documentation

- `docs/AI-generated/xian-template-engine-documentation.md` describes `{{title}}` in `head.xian`, but the real partial uses `{{ pageTitle }}` (`views/partials/head.xian` line 8). The `docs/` folder is excluded from Docker builds but is still in the repository.
- `README.md` is 2 bytes. The project has no setup instructions.
- `.env.example` lists `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` (lines 13–15), and `compose.dev.yaml` starts Redis, but no application code connects to Redis. Either wire it up (sessions) or remove it.
- `.env.example` lists `MAIL_*` as commented out, but no mail code exists.

### Empty and placeholder source files

- `app/http/middleware/requestLoggerMiddleware.js` is 0 bytes. It is not registered in `src/app.js`, so request logging does not exist.
- `app/http/controllers/auditTrailController.js` has a commented-out import of a non-existent `models/Audittrail.js` (line 1). The audit trail is the core ERP compliance feature, and it is not implemented. `app/models/audit-logs.js` defines the table, but no code writes to it.
- `app/http/controllers/homeController.js` renders Lorem ipsum (lines 4–5). `pageTitle: "XianFire Home!!!"` is template leftover.
- `views/pages/users.xian` line 3 prints "USER INDEX!" and `userController.index` passes `pageTitle: "Users!!!"` (line 48).

### Cosmetic CSS and template issues

- `views/layouts/main.xian` line 6 uses `text-xxl`, which is not a Tailwind class and has no effect. The same is in `views/pages/home.xian`.
- `views/layouts/main.xian` lines 27–32 place the `<style type="text/tailwindcss">` block after `</html>`. Browsers tolerate it, but it is invalid HTML.
- `views/layouts/main.xian` line 31 defines `.btn` as unlayered CSS, so Tailwind utilities cannot override it on the same element.
- `views/layouts/main.xian` line 4 uses `bg-default` and `border-b-1`, which are not defined Tailwind v4 utilities.
- `views/partials/userTable.xian` line 18 renders a literal `delete/edit` text placeholder in the Actions column.
- `views/layouts/authenticated.xian` includes `{{>sideNavBar}}` (line 5), and `views/partials/sideNavBar.xian` does not exist. Any render with `layout: "authenticated"` throws. No page currently uses this layout, so the failure is latent.
- SweetAlert2 is referenced by the project skill as part of the stack, but `views/partials/head.xian` does not load it.

### Health endpoint leaks operational data

- `app/http/controllers/api/v1/healthController.js` lines 48–56 return the service name, package version, process uptime, and server timestamp to any unauthenticated caller. This is fingerprinting data. Keep `/up` public and restrict `/health` to internal networks or require a token.

### Mixed UUID helpers and generation

- `app/models/helpers/uuid.js` uses `node:crypto` `randomUUID` for primary keys, while `authController.js` line 2 imports `uuid` (`package.json` line 52). Two UUID sources exist. Use `randomUUID` everywhere and drop the `uuid` package.

---

## Dead and Unfinished Code

- `app/http/controllers/userController.js`: `show`, `store`, `update`, `replace`, `destroy`, `create`, and `edit` are unfinished or dead (see Medium).
- `app/http/controllers/auditTrailController.js`: all methods are empty.
- `app/http/requests/user/storeUserRequest.js`, `updateUserRequest.js`: default-export stubs.
- `app/http/middleware/requestLoggerMiddleware.js`: empty file.
- `database/database.js`: builds a Drizzle client that is never exported or imported.
- `database/migrations/schema.ts`, `database/migrations/relations.ts`: introspection artifacts, not app code (see High).
- `src/RouteBuilder.js` line 1: marked `//! WIP...`. Its `apiResource` method (lines 56–91) is unused.
- `src/scripts/route-cache.js` and `src/scripts/create/*`: generate code for a different stack.

---

## Security Considerations (Consolidated)

| Area | Risk | Current state | Where |
| --- | --- | --- | --- |
| Authentication | Login cannot succeed; can crash process | Broken | `app/http/controllers/authController.js` 20–32 |
| Password storage | Unverifiable hash, manual salt, pepper with undefined fallback | Broken | `authController.js` 34–43; `config/cryptography.js` |
| Session | Insecure defaults, memory store, no regeneration | Insecure | `src/app.js` 35–41 |
| CSRF | No tokens on POST forms; GET logout | Missing | `src/app.js`; `routes/web.js` line 20 |
| Authorization | No guards on `/users`, `/audit-trail`, `/api/v1` | Missing | `routes/web.js`, `routes/api_v1.js` |
| Brute force | No rate limiting; account enumeration via messages | Missing | `routes/web.js` line 18; `authController.js` 24, 27 |
| Secrets | Fallback session secret, unset pepper, literal DB password | Insecure | `src/app.js` 37; `drizzle.config.js` 16; `.env.example` |
| Headers | No CSP, helmet, or SRI on CDN scripts | Missing | `views/partials/head.xian` 6–7 |
| Input | Unbounded body size, trim on passwords, weak name rule | Partial | `app/http/requests/auth/*.js`; `src/app.js` 25–31 |
| Information leak | Health endpoint reveals version and uptime | Exposed | `healthController.js` 48–56 |
| Container | Image includes `.claude/`, `.planning/`; wrong entry point | Insecure | `Dockerfile.prod` 12, 18; `.dockerignore` |

## Performance Bottlenecks

**Password hashing on every login attempt without a limit:**
- Problem: argon2 with `memoryCost: 2**16` (64 MB) runs per request. Unlimited unauthenticated requests can exhaust memory and CPU.
- Files: `config/cryptography.js` lines 1–6; `app/http/controllers/authController.js`.
- Improvement path: rate-limit `/login` and `/register`, and reuse one hashing pool when many requests are expected.

**Synchronous `route:cache` writes and top-level awaits:**
- Problem: `src/scripts/route-cache.js` writes files at module load. Importing it has side effects.
- Files: `src/scripts/route-cache.js` lines 114, 177, 202.
- Improvement path: wrap the logic in an exported function and call it from the CLI only.

**Template compilation in development:**
- Problem: `src/xian/engine.js` compiles templates on every request when `cache` is false, which is the development default (line 68 of `src/app.js`). Acceptable in development, but the production profile sets `cache: NODE_ENV === "production"`, so `NODE_ENV` must be set in the container. `Dockerfile.prod` line 6 sets it, which is correct.
- Files: `src/xian/engine.js` lines 29–56.

**Tailwind browser CDN at runtime:**
- Problem: `@tailwindcss/browser@4` compiles CSS in the browser on every page load. This is slow on low-end devices and produces a flash of unstyled content.
- Files: `views/partials/head.xian` line 6.
- Improvement path: move to a build step that emits static CSS, or accept the trade-off for an internal ERP and document it.

---

## Fragile Areas

**`src/xian/engine.js` template render path:**
- Files: `src/xian/engine.js` lines 77–110; `src/app.js` lines 62–66.
- Why fragile: `render` spreads `options` and `options._locals` (lines 84–87). `res.locals` overrides render data. The layout function receives the full `templateData` (line 100), so every page variable is visible to the layout. Strict mode throws on any missing property in development but silently prints nothing in production, so a page can work in production and crash in development.
- Safe modification: always pass every variable a template prints, and run the view checker in `.claude/skills/xian-view-engine/scripts/check-views.mjs` after changes.
- Test coverage: none.

**Strict mode split between environments:**
- Files: `src/app.js` line 64 (`strict: NODE_ENV === "development"`).
- Why fragile: a missing variable crashes development and is ignored in production. A bug can ship because nobody sees it locally until a production-only code path runs.
- Safe modification: enable strict mode in all environments for CI rendering tests.

**Watcher re-registers partials on every change:**
- Files: `src/xian/watcher.js` lines 17–57; `src/xian/partials.js` lines 116–121.
- Why fragile: `registerPartial` re-reads the file and calls `handlebars.registerPartial` on each add or change. It does not invalidate compiled templates that already inlined the old partial, so the first render after an edit can show stale output until the page itself is changed.
- Safe modification: restart the server after editing a partial that is used by many pages.

**Module-level side effects in `src/app.js`:**
- Files: `src/app.js` line 52 calls `registerRoutes(app)` at import time, while `bootstrap()` (lines 54–74) sets the view engine later.
- Why fragile: any code that imports `app` and tries to render before `bootstrap()` runs gets an error. `src/scripts/list-routes.js` imports `app` directly.
- Safe modification: keep `bootstrap()` as the only place that configures views, and call it before any render in new scripts.

**Dual entry point confusion:**
- Files: `src/app.js` (app definition, no listen) and `src/server.js` (listen).
- Why fragile: the Dockerfile uses the wrong one (see High), and the `main` field points to Electron. New contributors can start the wrong file.
- Safe modification: keep `src/server.js` as the only process entry, and document it.

## Test Coverage Gaps

**Authentication (login, register, logout, session):**
- What's not tested: every auth route and the session lifecycle.
- Files: `app/http/controllers/authController.js`, `app/http/requests/auth/loginRequest.js`, `app/http/requests/auth/registerRequest.js`.
- Risk: the login and register paths are already broken and nothing would have caught it.
- Priority: High

**Xian view engine:**
- What's not tested: template compilation, strict mode behavior, layout resolution, partial and helper registration, and the watcher.
- Files: `src/xian/engine.js`, `src/xian/partials.js`, `src/xian/helpers.js`, `src/xian/layouts.js`, `src/xian/watcher.js`.
- Risk: a regression breaks every page at once, and the failure only appears in the browser.
- Priority: High

**RouteBuilder:**
- What's not tested: method shadowing, include/exclude validation, and missing-handler errors.
- Files: `src/RouteBuilder.js`.
- Risk: the create and edit shadowing bug stays unnoticed.
- Priority: Medium

**Database layer and models:**
- What's not tested: anything in `app/models/`. No test connects to a database, and no migration test exists.
- Files: `app/models/*.js`, `database/database.js`, `database/migrations/`.
- Risk: schema drift (see High) goes undetected until runtime.
- Priority: High

**Validators:**
- What's not tested: every file in `app/http/requests/`. The stubs and the broken return shapes are untested.
- Files: `app/http/requests/**/*.js`.
- Risk: invalid input reaches controllers.
- Priority: Medium

## Scaling Limits

**Session storage:**
- Current capacity: `MemoryStore`, bounded by one process's RAM.
- Limit: sessions are lost on restart and cannot be shared across containers. The app cannot scale horizontally.
- Scaling path: use Redis (already in `compose.dev.yaml`) or MySQL as the session store.

**Single database connection pattern (once wired):**
- Current capacity: not applicable. No connection is created.
- Limit: a naive `drizzle(url)` per request would exhaust MySQL connections.
- Scaling path: create one pooled client at startup and export it.

## Dependencies at Risk

**`drizzle-orm` and `drizzle-kit` at `^1.0.0-rc.4`:**
- Risk: release candidate, API may change before a stable 1.0.
- Impact: upgrade breakage in models (`app/models/*.js`) and `drizzle.config.js`.
- Migration plan: pin to an exact version in `package-lock.json` (already locked) and track the stable release.

**`express` 4 with async handlers:**
- Risk: Express 4 does not forward rejected promises from async handlers to the error middleware. Any async throw is an unhandled rejection.
- Impact: the critical login and register crashes (see Critical).
- Migration plan: move to Express 5, which handles async errors natively, or add an async wrapper now.

**`studio@^0.13.5`:**
- Risk: unidentified runtime dependency with no imports in the codebase.
- Impact: unknown code runs in production.
- Migration plan: confirm its purpose, then remove it if unused.

**`bcrypt` alongside `argon2`:**
- Risk: two password hashing libraries, one unused.
- Impact: confusion about which one is authoritative.
- Migration plan: remove `bcrypt`, keep `argon2`.

**`electron` and `electron-builder`:**
- Risk: large install, unused after the Electron removal.
- Impact: slow `npm ci` in the devcontainer and in CI.
- Migration plan: remove both and the Electron scripts.

## Missing Critical Features

**Authentication that works:**
- Problem: login and register are broken (see Critical).
- Blocks: any protected page, any ERP action that needs a user identity, and the audit trail.

**Authorization and roles:**
- Problem: role and permission tables are defined in `app/models/roles.js`, `permissions.js`, `user-roles.js`, and `role-permissions.js`, but no code checks them.
- Blocks: multi-user pharmacy operations such as branch-restricted sales and controlled-substance approvals.

**Audit trail writes:**
- Problem: `app/models/audit-logs.js` defines the table. The controller is empty and nothing writes to it.
- Blocks: regulatory traceability for pharmaceutical records.

**Domain persistence:**
- Problem: products, inventory, sales, prescriptions, and dispensing exist as schema only. No controller reads or writes them (see Critical).
- Blocks: every ERP workflow.

**Forgot-password flow:**
- Problem: `views/pages/auth/forgotpassword.xian` says "Feature coming soon."
- Blocks: account recovery.

**Logging and observability:**
- Problem: `app/http/middleware/requestLoggerMiddleware.js` is empty and not registered. There is no error tracking.
- Blocks: diagnosing production incidents.

## Known Bugs (Consolidated)

| Symptom | Trigger | Files | Workaround |
| --- | --- | --- | --- |
| Process crash on any `POST /login` | Any login attempt | `app/http/controllers/authController.js` 21–26 | None. Remove `login` route until fixed. |
| Process crash on `POST /register` | Any registration, or missing body fields | `authController.js` 39; `app/http/requests/auth/registerRequest.js` 33–35 | None |
| `ReferenceError` on `GET /users` | Any request | `app/http/controllers/userController.js` 18 | None |
| 404 after logout | Click logout | `authController.js` 47; `views/pages/dashboard.xian` 5 | Visit `/login-page` manually |
| 404 on "Register" link on login page | Click link | `views/pages/auth/login.xian` 7 | Visit `/register-page` manually |
| 404 on "Login" link on register page | Click link | `views/pages/auth/register.xian` 8; `forgotpassword.xian` 4 | Visit `/login-page` manually |
| Dashboard redirect fails for logged-out users | Visit `/dashboard-page` without session | `authController.js` 16 | Visit `/login-page` |
| `create` and `edit` controller handlers never run | Request `/users/create` or `/users/:id/edit` | `src/RouteBuilder.js` 12–15, 47–50; `routes/web.js` 23 | Register explicit routes before `resource()` |
| Container exits with no HTTP server | `docker run` built from `Dockerfile.prod` | `Dockerfile.prod` 18; `src/app.js` 54–75 | Run `node src/server.js` instead |
| Page crashes in development | Render `layout: "authenticated"` | `views/layouts/authenticated.xian` 5 | Do not use this layout |
| `npm run migrate` fails | Any run | `package.json` line 13 | None: `src/scripts/migrate/` is missing |
| `npm run run`, `dev:electron`, `build`, `dist` fail | Any run | `package.json` 22–25 | Remove the scripts |
| `npm test` exits non-zero | Any run | `package.json` line 30 | None: `test:dep` is undefined |
| Feature test has no assertions | Any run | `tests/feature/products/getProducts.spec.js` | None |
| Schema file does not parse | `tsc` or any TypeScript tool | `database/migrations/schema.ts` line 35 | Delete the file |

---

## Recommended Priority Order

1. Fix the login and register handlers, then add tests for them (Critical).
2. Remove or secure the public `/users` route until real data and auth exist (Critical, High).
3. Decide and wire one database client, then reconcile the schema with the models (Critical, High).
4. Fix secrets fallbacks and Docker entry point before any deployment (Critical, High).
5. Add CSRF, session hardening, and rate limiting (High, Medium).
6. Clean dangling references in `package.json` and the CLI (High).
7. Replace the placeholder tests with real coverage (Medium).

---

*Concerns audit: 2026-11-12*
