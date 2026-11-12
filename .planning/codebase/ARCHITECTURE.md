---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
<!-- refreshed: 2026-11-12 -->
# Architecture

**Analysis Date:** 2026-11-12

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                 Entry: src/server.js (listens on PORT)               │
│        imports src/app.js → bootstrap() → app.listen()               │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│        Express middleware stack (`src/app.js`)                       │
│  express.json → urlencoded → static(`public/`, missing) → session    │
│  → connect-flash → res.locals.success_msg / error_msg                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  registerRoutes(app) — `routes/routes.js`
           ┌────────────────────┴────────────────────┐
           ▼                                         ▼
┌──────────────────────────────┐        ┌─────────────────────────────┐
│ web router  prefix `/`       │        │ api-v1 router `/api/v1`     │
│ `routes/web.js`              │        │ `routes/api_v1.js`          │
│ pages + form posts + resources│       │ `/up`, `/health` only       │
└──────────────┬───────────────┘        └──────────────┬──────────────┘
               ▼                                       ▼
┌──────────────────────────────┐        ┌─────────────────────────────┐
│ Controllers                  │        │ api/v1 healthController     │
│ `app/http/controllers/*`     │        │ `app/http/controllers/api/  │
│ (mostly stubs / hardcoded)   │        │   v1/healthController.js`   │
└──────┬─────────────┬─────────┘        └─────────────────────────────┘
       │ validate     │ res.render("page")  /  res.json(...)
       ▼              ▼
┌──────────────────┐ ┌──────────────────────────────────────────────────┐
│ Requests (zod)   │ │ Xian view engine `src/xian/`                     │
│ `app/http/       │ │ page `views/pages/**.xian` → layout              │
│  requests/**`    │ │ `views/layouts/main.xian` (default) wraps `{{{body}}}`│
└──────────────────┘ │ partials `views/partials/**`, helpers `views/helpers/*.js`│
                     └──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Data layer (schema only; NOT connected at runtime)                   │
│ Drizzle table definitions `app/models/*.js` + `relations.js`         │
│ Migrations `database/migrations/` ; connection `database/database.js`│
│ (imported by no runtime module)                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Pattern Overview

**Overall:** Server-rendered Express 4 MVC-style monolith (ES modules, `"type": "module"` in `package.json`) with a custom template engine (Xian) layered on an isolated Handlebars instance. Controllers, request validators, and models follow a Laravel-like naming convention, but the data layer is not yet wired into request handling.

**Key Characteristics:**
- Single Express process; no framework-level DI container. Wiring is explicit in `src/app.js` and `routes/*.js`.
- Views are server-rendered `.xian` files (Handlebars syntax) with a default layout, not a SPA. Styling uses the Tailwind v4 browser CDN and Bootstrap Icons from `views/partials/head.xian`.
- Session-based auth intent: `req.session.userId` is checked in `app/http/controllers/authController.js` (`dashboardPage`). Login/registration are not functional yet (see Anti-Patterns).
- Data model is declared with Drizzle ORM (`drizzle-orm/mysql-core`) in `app/models/`, with MySQL migrations generated into `database/migrations/` by `drizzle.config.js`. Runtime controllers use hardcoded arrays instead of querying the database.
- Route definitions go through a `RouteBuilder` helper (`src/RouteBuilder.js`) for resource-style CRUD routes; it is marked `//! WIP...` in source.
- Electron is referenced in `package.json` (`main`, `electron`, `dev:electron`, `dist` scripts) but the entry `electron/main.js` is deleted in the working tree (see Entry Points).

## Layers

**Bootstrap / Server:**
- Purpose: Start the HTTP server and initialize the view engine.
- Location: `src/server.js`, `src/app.js`
- Contains: `startServer()`, Express app creation, middleware, `bootstrap()` that calls `createXianEngine()`.
- Depends on: `src/xian/index.js`, `routes/routes.js`, `express-session`, `connect-flash`, `dotenv`.
- Used by: `npm start` / `npm run xian` (nodemon), `bin/xian.js`, `Dockerfile.prod` (see caveat below).

**Routing:**
- Purpose: Map URLs to controller methods, grouped by prefix.
- Location: `routes/routes.js` (group registry), `routes/web.js`, `routes/api_v1.js`, `src/RouteBuilder.js`
- Contains: `routeGroups` array (`web` at `/`, `api-v1` at `/api/v1`), `registerRoutes(app)`.
- Depends on: Controllers under `app/http/controllers/`.
- Used by: `src/app.js`, `src/scripts/list-routes.js` (walks router stacks).

**Controllers (HTTP handlers):**
- Purpose: Handle requests, call validators, render pages or return JSON.
- Location: `app/http/controllers/`
- Contains: `homeController.js` (fully functional, renders `home`), `authController.js` (page renders; `login`/`register` incomplete), `userController.js` (`index` renders hardcoded users; other methods stubs), `auditTrailController.js` (all empty stubs), `api/v1/healthController.js` (functional `/up` and `/health`).
- Depends on: `app/http/requests/*`, `config/cryptography.js`, `argon2`, `uuid`.
- Used by: `routes/web.js`, `routes/api_v1.js`.

**Request validation:**
- Purpose: Parse and validate request input with zod.
- Location: `app/http/requests/` (`auth/loginRequest.js`, `auth/registerRequest.js`, `user/getUserRequest.js`, `user/storeUserRequest.js`, `user/updateUserRequest.js`, `singleResourceRequest.js`)
- Contains: Functions taking `req` and returning either the parsed data or the zod issues array (inconsistent return type).
- Depends on: `zod`.
- Used by: Controllers. Note `userController.js` imports `updateUserRequest` and `storeUserRequest` but the `store`/`update` bodies do not use the result correctly.

**Middleware:**
- Purpose: Cross-cutting request processing.
- Location: Inline in `src/app.js` (body parsers, session, flash, locals). `app/http/middleware/requestLoggerMiddleware.js` exists but is an empty file and is not registered anywhere.

**View engine (Xian):**
- Purpose: Compile and render `.xian` templates with partials, a default layout, helpers, dev watching, and structured errors.
- Location: `src/xian/` (`engine.js` orchestrator; `partials.js`, `helpers.js`, `layouts.js`, `watcher.js`, `errors.js`, `index.js` public exports).
- Contains: `createXianEngine()` returning `{ engine, hbs, handlebars, templateCache, invalidateTemplate, close }`.
- Depends on: `hbs` (uses `hbs.create()` for an isolated Handlebars instance), `chokidar` (dev watcher), Node `fs/promises`.
- Used by: `src/app.js` through `app.engine("xian", xian.engine)`.

**Views and templates:**
- Purpose: HTML output.
- Location: `views/pages/` (routable pages), `views/layouts/` (`main.xian`, `authenticated.xian`), `views/partials/` (`head.xian`, `footer.xian`, `userTable.xian`, `css/base.xian`), `views/helpers/` (`currency.js`, `json.js`, `uppercase.js`).

**Data model (schema only):**
- Purpose: Declare MySQL tables, indexes, foreign keys, and Drizzle relations for the pharmacy ERP domain (branches, users, roles/permissions, products and inventory batches, sales, prescriptions, dispensing, returns, stock transfers, cash register sessions, audit logs).
- Location: `app/models/*.js` (40 files including `helpers/uuid.js`, `helpers/timestamps.js`, `relations/relations.js`), `app/models/inventory-views.js` (MySQL views `v_inventory_stock`, `v_expiring_inventory`).
- Depends on: `drizzle-orm/mysql-core`, `drizzle-orm`.
- Used by: `drizzle.config.js` (schema source for drizzle-kit), `database/migrations/schema.ts` (generated mirror). No runtime controller imports models.

**Database connection (unused):**
- Purpose: Create a Drizzle MySQL client from env vars.
- Location: `database/database.js`
- Contains: `drizzle("mysql://...", { relations })` built from `PROD_MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_NAME`.
- Depends on: `app/models/relations/relations`, `dotenv/config`.
- Used by: nothing in the runtime path. `src/scripts/create/model.js` (generator) imports a `sequelize` export from it, which this file does not provide.

**CLI / tooling:**
- Purpose: Developer commands.
- Location: `bin/xian.js` (wrapper that shells out to `npm run <script>`), `bin/test.js` (Japa runner), `src/scripts/` (`create/`, `list-routes.js`, `route-cache.js`, `utils.js`).

## Data Flow

### Primary Request Path (page render)

1. Express receives request; `express.json()` and `express.urlencoded()` parse body (`src/app.js`).
2. `express.static(path.join(process.cwd(), "public"))` runs. The `public/` directory is not in the repo.
3. `express-session` loads/creates the session (`src/app.js`), then `connect-flash` and a locals middleware populate `res.locals.success_msg` and `res.locals.error_msg`.
4. `registerRoutes(app)` mounts the `web` router at `/` (`routes/routes.js` → `routes/web.js`).
5. Route handler, e.g. `GET /login-page` → `authController.loginPage` (`app/http/controllers/authController.js`) calls `res.render("auth/login", { pageTitle: "Login" })`.
6. Express resolves the view via `app.set("views", views/pages)` and `app.set("view engine", "xian")`, so it calls the Xian `render` in `src/xian/engine.js`.
7. Xian compiles `views/pages/auth/login.xian` (cached only when `NODE_ENV=production`), renders it with `strict` mode in development, then resolves the layout `main` (default) from `views/layouts/main.xian`.
8. The layout's `{{>head}}`, `{{>footer}}` partials are resolved from the partials registry; `{{{body}}}` receives the rendered page. Response HTML is returned via the Express callback.

### Form submission (intended, incomplete)

1. Browser posts `views/pages/auth/login.xian` form to `POST /login`.
2. `authController.login` calls `loginRequest(req)` (`app/http/requests/auth/loginRequest.js`). The result is not checked before use, and `user`/`match` are undefined in the function body, so the call throws a ReferenceError at runtime.
3. Intended success path: `req.session.userId = user.id` then redirect to `/dashboard`; `dashboardPage` (`authController.js`) guards on `req.session.userId`.

### JSON API path

1. `GET /api/v1/up` or `/api/v1/health` (`routes/api_v1.js`) → `healthController` returns JSON. This is the only fully functional JSON endpoint.

### Users page (hardcoded data)

1. `GET /users` → `userController.index` (via `routeBuilder.resource("/users", userController)` in `routes/web.js`).
2. The function body calls `getUserRequest(req)` and then `insert.data(data)`, where `insert` and `data` are undefined, so the handler throws before rendering. The render call with a hardcoded array is unreachable. Treat this route as broken.

**State Management:**
- Server-side session via `express-session` with the in-memory default store (no Redis store is wired, despite `REDIS_*` variables in `.env.example` and `compose.dev.yaml`).
- Flash messages via `connect-flash`.
- Template cache: `Map` inside `createXianEngine()` (`src/xian/engine.js`), active only when `cache` is true (`NODE_ENV === "production"`).

## Key Abstractions

**Route group registry:**
- Purpose: Declare mounted routers with prefixes and names, used by both the app and `route:list`.
- Examples: `routes/routes.js` (`routeGroups`, `registerRoutes`).
- Pattern: Frozen array of `{ name, prefix, router }`.

**RouteBuilder:**
- Purpose: Laravel-style `resource()`/`apiResource()` registration with include/exclude filters; validates that a controller implements each required method.
- Examples: `src/RouteBuilder.js`, used in `routes/web.js` for `/users` and `/audit-trail`.
- Pattern: Method table mapping action names to HTTP verb + URI, then `router[method](uri, controller[action])`. Marked WIP in source.

**Xian engine:**
- Purpose: Express-compatible view engine around Handlebars with conventions for pages, layouts, partials, helpers.
- Examples: `src/xian/engine.js` (entry), `src/xian/partials.js` (partial name = path relative to `views/partials` without `.xian`, e.g. `css/base`), `src/xian/helpers.js` (file name = helper name, e.g. `currency.js` → `currency`).
- Pattern: Factory `createXianEngine(options)` returning an object with lifecycle hooks (`close()`, `invalidateTemplate()`).

**Request validators:**
- Purpose: Per-endpoint zod schemas.
- Examples: `app/http/requests/auth/loginRequest.js`, `app/http/requests/singleResourceRequest.js`.
- Pattern: Named function `(req) => data | issues`. Note `singleResourceRequest` uses `z.int()`, which requires zod v4 (present in `package.json`).

**Drizzle table modules:**
- Purpose: One file per table with shared helpers for UUID primary keys and timestamps.
- Examples: `app/models/users.js`, `app/models/roles.js`, `app/models/user-roles.js`, `app/models/helpers/uuid.js` (`uuidPrimaryKey()` generates IDs in the app via `randomUUID`, not via DB default), `app/models/helpers/timestamps.js`.
- Pattern: `t.mysqlTable(name, columns, (table) => [indexes, foreignKeys])`; the central relation map is `app/models/relations/relations.js` (`defineRelations`).

## Entry Points

**Server (primary, dev and production):**
- Location: `src/server.js`
- Triggers: `npm start` (`node ./src/server.js`), `npm run xian` (nodemon), `xian` CLI (`bin/xian.js`).
- Responsibilities: Load `.env` via dotenv, call `bootstrap()`, listen on `PORT` (default 3000).

**Express app module:**
- Location: `src/app.js` (default export `app`, named export `bootstrap`).
- Triggers: Imported by `src/server.js`, `src/scripts/list-routes.js`.
- Responsibilities: Middleware and route registration. It does not call `listen()`.

**Docker production image (broken as written):**
- Location: `Dockerfile.prod` (`CMD ["node", "src/app.js"]`).
- Problem: `src/app.js` never listens and never calls `bootstrap()`, so the container exits without serving HTTP and rendering would fail with no view engine registered. The intended entry is `src/server.js`.

**Electron (dangling):**
- `package.json` sets `"main": "electron/main.js"` and scripts `electron`, `dev:electron`, `run`, `build`, `dist`. `electron/main.js` is deleted in the working tree (tracked in HEAD). `run` also calls `nodemon index.js`, and no `index.js` exists at the repo root.

**CLI wrapper:**
- Location: `bin/xian.js`. Maps aliases (`s`, `d`, `m`, `t`, `b`, `r`) to npm scripts. Help text says `xian test` runs Jest, but the project uses Japa (`bin/test.js`).

**Test runner:**
- Location: `bin/test.js` (Japa suites `browser`, `feature`, `unit`, with `apiClient("http://localhost:3000")`).

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop. No worker threads. Argon2 hashing (`argon2` package) runs in its native threadpool.
- **Global state:** `src/app.js` exports a module-level singleton `app`; `bootstrap()` mutates it (`app.engine`, `app.set`). The Xian engine instance is created inside `bootstrap()` and only reachable through Express. `routes/web.js` and `routes/api_v1.js` create module-level `express.Router()` singletons. `src/scripts/list-routes.js` relies on the same singletons.
- **Initialization order:** `registerRoutes(app)` runs at module load (in `src/app.js`) before `bootstrap()` registers the view engine. This works only because rendering occurs at request time. Any code that imports `app` and renders without calling `bootstrap()` will fail.
- **Circular imports:** None found among the reviewed modules. `dependency-cruiser` config (`.dependency-cruiser.cjs`) enforces `no-circular`, but its `required` rules are stale: rule "model - sequelize Datatypes" requires `app/models` to reach `sequelize`, and rule "http/request - zod" points at `database/database.js` (copy-paste). These contradict the Drizzle-based models.
- **Data access split:** Schema is Drizzle; `src/scripts/create/model.js` generates Sequelize models that import `sequelize` from `database/database.js`, which only exports a Drizzle instance. The two ORMs are both declared in `package.json` (`drizzle-orm`, `sequelize`).
- **Stale dependencies:** `package.json` lists `studio`, `inquirer`, `bcrypt` (plus `argon2`), `sequelize`, `uuid` (while `crypto.randomUUID` is used in `app/models/helpers/uuid.js`). Redis is in the compose files and `.env.example` but has no client dependency.
- **Filesystem coupling:** `express.static` uses `process.cwd()` for `public/`, while views use `__dirname`-relative paths. Starting the server from another directory breaks static assets but not views.

## Anti-Patterns

### Controllers that reference undefined identifiers

**What happens:** `app/http/controllers/authController.js` (`login`, `register`), `app/http/controllers/userController.js` (`index`, `store`), and `app/http/controllers/auditTrailController.js` reference names never declared in scope (`user`, `match`, `password`, `insert`, `data`, `product`) or call `res.json({...}).status(201)` in the wrong order.
**Why it's wrong:** These throw ReferenceError or send no response at request time, so the requests hang or return 500.
**Do this instead:** Declare each variable explicitly, validate with the request module, use `res.status(201).json(...)`. For login, look up the user via the Drizzle client once `database/database.js` is wired into the app.

### Hardcoded data in controllers

**What happens:** `app/http/controllers/userController.js` `index` defines a literal array of users, with a commented-out `User.findAll()`.
**Why it's wrong:** The page does not reflect the database, and the same pattern will be copied to other pages.
**Do this instead:** Query via Drizzle (`db.query.users.findMany`), using the relations in `app/models/relations/relations.js`. Place the database client in `database/database.js` and import it from controllers, not from models.

### Validators with inconsistent return values

**What happens:** `app/http/requests/auth/loginRequest.js` returns the parsed data on success and `error.issues` on failure. Callers cannot distinguish success from failure without inspecting the value.
**Do this instead:** Use `schema.safeParse(data)` and return `{ success, data, error }`, or throw a typed validation error that a central handler maps to a 422.

### Stale or missing references in the config and scripts

**What happens:** `package.json` scripts reference `src/scripts/migrate/*.js`, `index.js`, and `electron/main.js`, none of which exist. `src/scripts/route-cache.js` appends to `routes/index.js`, which does not exist (routes are in `routes/routes.js`). `src/scripts/create/model.js` imports `sequelize` from `database/database.js`.
**Do this instead:** Point each script at the file that exists, or remove it. Keep one ORM.

## Error Handling

**Strategy:** Template errors are wrapped in `XianTemplateError` (`src/xian/errors.js`) with template path, line, and column. Partial and layout resolution errors use plain `Error`. Express-level errors use the default handler; no custom error-handling middleware is registered in `src/app.js`.

**Patterns:**
- `createTemplateError(error, templatePath)` normalizes Handlebars compile and render errors.
- `Engine.render` passes errors to the Express callback (`callback(xianError)`).
- Watcher errors are logged with `console.error` (`src/xian/watcher.js`) and do not crash the process.
- Missing partials and helpers surface as Handlebars errors at render time in strict mode (`strict: NODE_ENV === "development"` in `src/app.js`).

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` only. `app/http/middleware/requestLoggerMiddleware.js` is empty and unregistered. Watcher events log to stdout (`src/xian/watcher.js`).

**Validation:** zod schemas in `app/http/requests/`. Only the login and single-resource paths parse input; most handlers do not call a validator, or ignore its result.

**Authentication:** Session-based. `authController.dashboardPage` checks `req.session.userId`. `logout` destroys the session (`req.session.destroy()`), then redirects. No auth middleware is applied to other routes. `config/cryptography.js` configures Argon2id (`ARGON2_*` env vars). The `register` and `login` flows that use it are incomplete. Note that `SECRET_KEY` is used as the password pepper in `authController.register` and as the session secret in `src/app.js`, with a fallback literal (`"development-secret"`) when unset.

**Authorization:** Not implemented. The `roles`, `permissions`, `user-roles`, and `role-permissions` tables exist in `app/models/` but nothing checks them at request time.

**Security headers and CSRF:** Not configured. No `helmet`, no CSRF token in forms (`views/pages/auth/login.xian`). Session cookie options are the `express-session` defaults.

## Where Things Live (quick reference)

For file-by-file placement, see `.planning/codebase/STRUCTURE.md`.

---

*Architecture analysis: 2026-11-12*
