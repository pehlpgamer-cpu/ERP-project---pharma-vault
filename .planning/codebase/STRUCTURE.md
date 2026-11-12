---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
# Codebase Structure

**Analysis Date:** 2026-11-12

## Directory Layout

```
ERP-project---pharma-vault/
├── app/                      # Application code (controllers, requests, models)
│   ├── http/
│   │   ├── controllers/      # Request handlers (web + api/v1)
│   │   ├── middleware/       # requestLoggerMiddleware.js (empty, unused)
│   │   └── requests/         # zod request validators
│   └── models/               # Drizzle MySQL table definitions (40 files)
│       ├── helpers/          # uuid.js, timestamps.js
│       └── relations/        # relations.js (defineRelations map)
├── bin/                      # CLI wrapper (xian.js) and Japa runner (test.js)
├── config/                   # cryptography.js (Argon2), database.js; app.js is empty
├── database/                 # Drizzle connection + generated migrations
│   └── migrations/           # SQL migrations + snapshots, schema.ts, relations.ts
├── docs/                     # AI-generated Xian engine documentation
├── routes/                   # Route groups: routes.js, web.js, api_v1.js
├── src/                      # Framework core: server, app, Xian engine, RouteBuilder, scripts
│   ├── scripts/              # create/, list-routes.js, route-cache.js, utils.js
│   └── xian/                 # Xian view engine (Handlebars wrapper)
├── tests/                    # Japa suites: browser/, feature/, unit/
├── views/                    # .xian templates and Handlebars helpers
│   ├── helpers/              # currency.js, json.js, uppercase.js
│   ├── layouts/              # main.xian, authenticated.xian
│   ├── pages/                # Routable pages (home, dashboard, users, auth/*)
│   └── partials/             # head, footer, userTable, css/base
├── electron/                 # DELETED in working tree (tracked in HEAD); see Special Directories
├── .devcontainer/            # VS Code dev container (uses compose.dev.yaml)
├── .vscode/                  # Editor settings (*.xian mapped to html)
├── .planning/codebase/       # Generated codebase maps (this document)
├── .claude/                  # Local Claude Code config (untracked); not application code
├── package.json              # Scripts, dependencies, electron-builder config
├── package-lock.json
├── drizzle.config.js         # drizzle-kit config (schema: app/models, out: database/migrations)
├── .dependency-cruiser.cjs   # Dependency rules
├── .oxlintrc.json / .oxfmtrc.json  # oxlint / oxfmt config
├── .editorconfig
├── .env.example              # Environment variable template (names only)
├── Dockerfile.prod           # Production image (CMD references src/app.js; see caveat)
├── compose.dev.yaml          # Dev stack: devcontainer, mysql 8.4, redis
├── compose.prod.yaml         # Stub (no services defined)
├── .dockerignore / .gitignore
└── LICENSE / README.md       # README.md is 2 bytes
```

## Directory Purposes

**`app/http/controllers/`:**
- Purpose: HTTP handlers, one object per resource with Laravel-style method names (`index`, `show`, `store`, `update`, `replace`, `destroy`, `create`, `edit`).
- Contains: `homeController.js` (function export `homePage`), `authController.js` (default object), `userController.js`, `auditTrailController.js`, `api/v1/healthController.js`.
- Key files: `app/http/controllers/authController.js`, `app/http/controllers/userController.js`, `app/http/controllers/api/v1/healthController.js`.

**`app/http/requests/`:**
- Purpose: zod validators per endpoint, grouped by domain.
- Contains: `auth/loginRequest.js`, `auth/registerRequest.js`, `user/getUserRequest.js`, `user/storeUserRequest.js`, `user/updateUserRequest.js`, `singleResourceRequest.js`.
- Note: `user/storeUserRequest.js` and `user/updateUserRequest.js` export empty default functions (`export default () => {};`). `user/getUserRequest.js` is a stub. Only `auth/loginRequest.js` and `singleResourceRequest.js` contain real zod schemas.

**`app/http/middleware/`:**
- Purpose: Intended home for custom middleware.
- Contains: `requestLoggerMiddleware.js` (0 bytes). Not imported.

**`app/models/`:**
- Purpose: Drizzle table definitions. One file per table, kebab-case file name, camelCase export (`cash-register-sessions.js` exports `cashRegisterSessions`).
- Key files: `app/models/users.js`, `app/models/branches.js`, `app/models/roles.js`, `app/models/user-roles.js`, `app/models/sales.js`, `app/models/sale-items.js`, `app/models/inventory-batches.js`, `app/models/inventory-views.js` (MySQL views), `app/models/audit-logs.js`.
- Domain groups (by file name): identity (`users`, `roles`, `permissions`, `user-roles`, `role-permissions`, `branches`); catalog (`products`, `product-categories`, `product-units`, `product-barcodes`, `units`, `manufacturers`); inventory (`inventories`, `inventory-batches`, `inventory-movements`, `inventory-adjustments`, `inventory-adjustment-items`, `stock-transfers`, `stock-transfer-items`, `inventory-views`); point of sale (`sales`, `sale-items`, `sale-item-batches`, `sale-payments`, `cash-registers`, `cash-register-sessions`, `cash-transactions`, `customers`); prescriptions (`prescribing-physicians`, `prescriptions`, `prescription-items`, `sale-prescriptions`, `dispensings`, `dispensing-items`); returns (`sales-returns`, `sales-return-items`, `refunds`); audit (`audit-logs`).

**`app/models/helpers/`:**
- `uuid.js`: `uuid(name)` (char(36), ascii_bin), `uuidPrimaryKey()` (app-generated via `randomUUID`).
- `timestamps.js`: default export with `createdAt` and `updatedAt` (`onUpdateNow`).

**`app/models/relations/`:**
- `relations.js`: single `defineRelations` call covering all tables. Add new relations here, not in individual model files.

**`bin/`:**
- `bin/xian.js`: shell wrapper around `npm run`. Entry for the `xian` bin declared in `package.json`.
- `bin/test.js`: Japa runner configuration (suites `browser`, `feature`, `unit`).

**`config/`:**
- `config/cryptography.js`: `argon2Config` read from `ARGON2_*` env vars.
- `config/database.js`: `dbConfig` with empty `development` and `production` objects (unused).
- `config/app.js`: empty file (0 bytes).

**`database/`:**
- `database/database.js`: Drizzle MySQL client (not imported by runtime code).
- `database/migrations/`: two timestamped drizzle-kit folders, each with `migration.sql` and `snapshot.json`. Also `schema.ts` (about 36 KB) and `relations.ts`, which mirror the models in TypeScript.

**`routes/`:**
- `routes/routes.js`: `routeGroups` and `registerRoutes(app)`.
- `routes/web.js`: page routes, `/login`, `/register`, `/logout`, plus `resource` routes for `/users` and `/audit-trail`.
- `routes/api_v1.js`: `/up` and `/health`.

**`src/`:**
- `src/server.js`: process entry (listen).
- `src/app.js`: Express app and `bootstrap()`.
- `src/RouteBuilder.js`: resource route helper (WIP).
- `src/xian/`: view engine (see below).
- `src/scripts/`: developer tooling; `create/` contains generators (`index.js`, `model.js`, `controller.js`, `request.js`); `list-routes.js` prints the route table (`--group`); `route-cache.js` appends cache routes to a file that does not exist; `utils.js` has naming helpers.

**`src/xian/`:**
- `engine.js`: `createXianEngine()`, render function, template cache, layout rendering.
- `partials.js`: recursive registration of `views/partials/**/*.xian`, names like `css/base`.
- `helpers.js`: loads `views/helpers/*.js`; helper name is the file name.
- `layouts.js`: `resolveLayout()` returns `views/layouts/<name>.xian` or throws.
- `watcher.js`: chokidar watcher (dev only) over partials, layouts, helpers.
- `errors.js`: `XianTemplateError` and `createTemplateError()`.
- `index.js`: public exports (`createXianEngine`, `XianTemplateError`).

**`tests/`:**
- `tests/feature/products/getProducts.spec.js`: calls `GET /products`, which has no route.
- `tests/browser/browser.spec.js`: visits `https://japa.dev/docs` (external site, not the app).
- `tests/unit/maths.spec.js`: unit placeholder.

**`views/`:**
- `views/pages/`: Each `.xian` file is addressable by `res.render("<path without ext>")`. Files: `home.xian`, `dashboard.xian`, `users.xian`, `auth/login.xian`, `auth/register.xian`, `auth/forgotpassword.xian`.
- `views/layouts/`: `main.xian` (default; nav links to `/`, `/login-page`, `/register-page`, `/users`), `authenticated.xian` (uses `{{>sideNavBar}}`, which is missing from `views/partials/`).
- `views/partials/`: `head.xian` (Tailwind CDN, Bootstrap Icons CDN, `<title>{{pageTitle}}</title>`), `footer.xian`, `userTable.xian`, `css/base.xian`.
- `views/helpers/`: `currency.js` (`Intl.NumberFormat` en-PH PHP), `json.js`, `uppercase.js`.

**`docs/`:**
- `docs/AI-generated/xian-template-engine-documentation.md`: engine documentation. Excluded from Docker context.

**`.planning/codebase/`:**
- Generated analysis documents for GSD workflows. Not application code.

**`.claude/` (untracked):**
- Holds the project skill `.claude/skills/xian-view-engine/` (SKILL.md, references, scripts, assets). Local tooling only. Not application code.

## Key File Locations

**Entry Points:**
- `src/server.js`: process start, listens on `PORT`.
- `src/app.js`: Express app, middleware, `bootstrap()`.
- `bin/xian.js`: `xian` CLI.
- `Dockerfile.prod`: `CMD ["node", "src/app.js"]` (does not listen; prefer `src/server.js`).

**Configuration:**
- `package.json`: scripts, dependencies, electron-builder `build` block, `engines.node >= 24`.
- `drizzle.config.js`: drizzle-kit (MySQL dialect, `casing: snake_case`, `strict: true`). Contains hardcoded local database credentials. Read from env instead.
- `.env.example`: variable names for the app, MySQL container, Redis, Argon2, and commented mail settings.
- `config/cryptography.js`: Argon2id parameters.
- `.dependency-cruiser.cjs`, `.oxlintrc.json`, `.oxfmtrc.json`, `.editorconfig`.
- `compose.dev.yaml`: devcontainer, MySQL 8.4 on port 3306, Redis 8.10.2.

**Core Logic:**
- `app/http/controllers/`: handlers (mostly stubs).
- `src/xian/engine.js`: view engine.
- `app/models/relations/relations.js`: full relation graph.

**Testing:**
- `bin/test.js`: runner config.
- `tests/unit/`, `tests/feature/`, `tests/browser/`: Japa specs (see Directory Purposes).

**Views:**
- `views/pages/`, `views/layouts/`, `views/partials/`, `views/helpers/`.

## Naming Conventions

**Files:**
- Controllers: camelCase with `Controller` suffix: `userController.js`, `authController.js`, `homeController.js`.
- Requests: camelCase with `Request` suffix, grouped by domain folder: `app/http/requests/auth/loginRequest.js`.
- Models: kebab-case plural table names: `app/models/cash-register-sessions.js`. Export is camelCase: `cashRegisterSessions`.
- Routes: lowercase single word: `routes/web.js`, `routes/api_v1.js` (underscore in `api_v1`, the only file in the repo that uses it).
- Xian templates: `.xian`. Pages and partials use camelCase or lowercase: `forgotpassword.xian`, `userTable.xian`, `footer.xian`. Layouts are lowercase: `main.xian`.
- Helpers: lowercase single word, file name is the Handlebars helper name: `views/helpers/currency.js` → `{{currency value}}`.
- Source and engine files: lowercase single word in `src/xian/`.

**Directories:**
- Lowercase, single word or hyphen-free. Exceptions: `app/models/relations/`, `app/models/helpers/` (plain), `src/scripts/create/`.

**Database objects:**
- Tables: snake_case plural (`users`, `cash_register_sessions`), via drizzle `casing: 'snake_case'` plus explicit names in table definitions.
- Indexes: `uq_<table>_<col>`, `idx_<table>_<col>`; foreign keys: `fk_<table>_<target>`.
- Views: `v_<name>` (`v_inventory_stock`, `v_expiring_inventory`).

**Routes:**
- Resource URIs use plural nouns with kebab-case: `/audit-trail`, `/users`. Login/register pages use `-page` suffix: `/login-page`, `/register-page`, `/forgot-password-page`, `/dashboard-page`. Note `/dashboard` (the post-login redirect target) is not registered as a route, only `/dashboard-page` is.

## Where to Add New Code

**New web page:**
- Template: `views/pages/<area>/<name>.xian`, rendered by `res.render("<area>/<name>", { pageTitle })`.
- Route: add to `routes/web.js`.
- Controller method: `app/http/controllers/<name>Controller.js`.
- Layout is `main` by default; pass `layout: "authenticated"` or `layout: false` as needed.

**New API endpoint:**
- Route: `routes/api_v1.js`. Add a new group in `routes/routes.js` if it needs a different prefix.
- Controller: `app/http/controllers/api/v1/<name>Controller.js`.
- Validator: `app/http/requests/<domain>/<action>Request.js`.

**New resource CRUD:**
- Use `routeBuilder.resource("/uri", controller)` in `routes/web.js`. Controller must implement every method the builder selects, or startup throws `TypeError`.
- Scaffold with `npm run create:controller` and `npm run create:model` (`src/scripts/create/`). Note the model generator emits Sequelize code, which conflicts with the Drizzle models here.

**New table:**
- Model: `app/models/<table-name>.js` using `uuidPrimaryKey()`, `timestamps`, and `uuid()` from `app/models/helpers/`.
- Register in `app/models/relations/relations.js` (add to the `defineRelations` table object and relations callback).
- Generate migration: `npx drizzle-kit generate` (config in `drizzle.config.js`, output `database/migrations/`).

**New partial:**
- `views/partials/<name>.xian`, or `views/partials/<group>/<name>.xian` for nested use (`{{>group/name}}`). Registered automatically on startup and in dev watch mode.

**New helper:**
- `views/helpers/<name>.js`, default export a function. Auto-registered under the file name.

**New middleware:**
- `app/http/middleware/<name>Middleware.js`, then register in `src/app.js` before `registerRoutes(app)`.

**Shared utilities:**
- `src/scripts/utils.js` is for CLI generators only. Application helpers have no designated folder yet.

**New tests:**
- Unit: `tests/unit/<name>.spec.js`. Feature (HTTP via `apiClient`): `tests/feature/<area>/<name>.spec.js`. Browser: `tests/browser/<name>.spec.js`.

## Special Directories

**`electron/`:**
- Purpose: Previously the Electron main process (`electron/main.js`).
- Generated: No. Committed: tracked in HEAD, but deleted in the working tree (uncommitted deletion). Dangling references remain in `package.json` (`main`, `electron`, `dev:electron`, `run`, `build`, `dist`), in `.dockerignore` (`electron/` excluded), and in `electron-builder` config.

**`public/`:**
- Purpose: Static assets served by `express.static(process.cwd() + "/public")`.
- Generated: No. Committed: Does not exist in this checkout.

**`node_modules/`:**
- Not installed in this checkout. Dependencies are declared in `package.json` and locked in `package-lock.json`.

**`database/migrations/`:**
- Purpose: drizzle-kit output; each subfolder is one migration with `migration.sql` and `snapshot.json`.
- Generated: Yes (drizzle-kit). Committed: Yes.

**`.planning/`:**
- Purpose: GSD planning artifacts; `codebase/` holds these maps. Not in `.gitignore`.

**`.claude/`:**
- Purpose: Local Claude Code configuration and the `xian-view-engine` project skill. Untracked in git.

**`.devcontainer/`, `.vscode/`:**
- Editor and container configuration. `.vscode/settings.json` maps `*.xian` to `html`.

## Dangling References

These paths are referenced but do not exist in the working tree:

- `electron/main.js` (deleted; referenced by `package.json` `main` and the electron scripts)
- `index.js` (`package.json` script `run`)
- `src/scripts/migrate/migrate.js`, `fresh.js`, `drop.js` (scripts `migrate`, `migrate:fresh`, `migrate:drop`, and `xian migrate` in `bin/xian.js`)
- `routes/index.js` (appended to by `src/scripts/route-cache.js`)
- `views/partials/sideNavBar.xian` (used by `views/layouts/authenticated.xian`)
- `public/` (static root in `src/app.js`)
- `tests` route `/products` (`tests/feature/products/getProducts.spec.js`)
- `sequelize` export in `database/database.js` (imported by `src/scripts/create/model.js`)

---

*Structure analysis: 2026-11-12*
