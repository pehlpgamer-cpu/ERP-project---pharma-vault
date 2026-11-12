---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
# Coding Conventions

**Analysis Date:** 2026-11-12

## Naming Patterns

**Files:**
- JavaScript modules use kebab-case for Drizzle table models: `app/models/sale-items.js`, `app/models/cash-register-sessions.js`, `app/models/inventory-adjustment-items.js`.
- Single-word model files are lowercase: `app/models/users.js`, `app/models/sales.js`.
- Controllers use camelCase with a `Controller` suffix: `app/http/controllers/authController.js`, `app/http/controllers/userController.js`, `app/http/controllers/auditTrailController.js`, `app/http/controllers/homeController.js`.
- Versioned API controllers live under `app/http/controllers/api/v1/` and are named `healthController.js`.
- Request validators use camelCase with a `Request` suffix: `app/http/requests/auth/loginRequest.js`, `app/http/requests/user/storeUserRequest.js`, `app/http/requests/singleResourceRequest.js`.
- Middleware uses camelCase with a `Middleware` suffix: `app/http/middleware/requestLoggerMiddleware.js` (file is currently empty).
- Xian view helpers are named for the helper they expose, lowercase: `views/helpers/currency.js`, `views/helpers/json.js`, `views/helpers/uppercase.js`. The engine derives the Handlebars helper name from the file name (`src/xian/helpers.js`, `createHelperName`), so the file name IS the helper name and must be a valid identifier.
- Xian page, layout and partial templates use camelCase or lowercase names with the `.xian` extension: `views/pages/auth/login.xian`, `views/partials/userTable.xian`, `views/layouts/main.xian`.
- Framework internals under `src/xian/` use lowercase single words: `engine.js`, `errors.js`, `helpers.js`, `layouts.js`, `partials.js`, `watcher.js`.
- Generated or utility scripts under `src/scripts/` use lowercase names: `route-cache.js`, `list-routes.js`, `utils.js`.

**Functions:**
- Functions and handlers are camelCase: `homePage` in `app/http/controllers/homeController.js`, `loginRequest` in `app/http/requests/auth/loginRequest.js`, `createXianEngine` in `src/xian/engine.js`.
- Factory helpers that build Drizzle column definitions use the `uuid` / `uuidPrimaryKey` naming in `app/models/helpers/uuid.js`.
- Controller objects expose the resource action names as keys: `index`, `show`, `store`, `update`, `replace`, `destroy`, `create`, `edit` (see `app/http/controllers/userController.js` and `src/RouteBuilder.js`). Keep these names; `RouteBuilder.resource()` binds them to routes by key and throws if a method is missing.
- Express handlers are usually arrow functions stored as object properties: `(req, res) => { ... }`.

**Variables:**
- camelCase for locals and object fields: `pageTitle`, `cashRegisterSessionId`, `branchId`.
- Constants use camelCase too, except module-level config/option objects which are camelCase (`argon2Config` in `config/cryptography.js`, `viewDirectories` in `src/app.js`) and environment constants that are UPPER_SNAKE_CASE when read from `process.env` (`NODE_ENV` in `src/app.js` and `src/server.js`, `PORT` in `src/server.js`).
- Route groups are frozen config arrays: `routeGroups` in `routes/routes.js`.

**Types and schema identifiers:**
- Drizzle JS property names are camelCase and map to snake_case columns through explicit column names: `branchId: uuid("branch_id")` in `app/models/users.js`. `drizzle.config.js` also sets `casing: 'snake_case'`.
- Database table names are snake_case plural: `"users"`, `"sales"`, `"cash_register_sessions"` (see `app/models/users.js`, `app/models/sales.js`).
- Index and constraint names use prefixes: `uq_` for unique, `idx_` for index, `fk_` for foreign key, `chk_` for check. Example: `uq_users_email`, `idx_sales_branch_date`, `fk_sales_branch`, `chk_sales_amounts` in `app/models/sales.js` and `app/models/users.js`.
- Enumerations are `t.mysqlEnum([...])` with UPPER_CASE values, e.g. `"PENDING"`, `"COMPLETED"`, `"PARTIALLY_REFUNDED"` in `app/models/sales.js`.

## Code Style

**Formatting:**
- Indentation: 2 spaces, LF line endings, UTF-8, final newline, trimmed trailing whitespace (`.editorconfig`).
- Formatter: `oxfmt` (devDependency `oxfmt`, config `.oxfmtrc.json` with only `ignorePatterns: []`). Scripts: `npm run fmt` and `npm run fmt:check`.
- Quotes are double quotes in most source files (`app/`, `routes/`, `src/app.js`). Some files use single quotes (`database/database.js`, `drizzle.config.js`, `src/server.js` partially). Prefer double quotes.
- Semicolons are used in most files, but controllers such as `app/http/controllers/userController.js` and `app/http/controllers/api/v1/healthController.js` omit them in places. Write semicolons.
- Trailing commas are used in multi-line object and argument lists (`app/models/users.js`, `src/app.js`).

**Linting:**
- Linter: `oxlint` (devDependency `oxlint`, config `.oxlintrc.json`). Scripts: `npm run lint` and `npm run lint:fix`.
- Enabled plugins: `typescript`, `unicorn`, `oxc`. The `correctness` category is set to `error`.
- Explicit rules in `.oxlintrc.json`:
  - `eslint/curly`: `["error", "all"]` — every `if`/`else`/loop body must use braces, even single statements. Note that `src/xian/helpers.js` and `src/xian/engine.js` already follow this; many `if (...) {return ...;}` one-liners in `app/` follow it too.
  - `arrow-body-style`: `["error", "always", { requireReturnForObjectLiteral: true }]` — arrow functions must use a block body. Prefer `(req, res) => { return res.render(...); }` over expression bodies.
  - `default-case-last`, `default-param-last`: `error`.
- Env: `builtin: true` (Node globals available).
- The code does not uniformly follow the lint config. Block-bodied single-line arrows such as `loginPage: (_req, res) => {return res.render(...)}` in `app/http/controllers/authController.js` and `src/xian/helpers.js` are common. Treat `.oxlintrc.json` as the target for new code. Running `npm run lint` is the authoritative check; it was not run for this analysis.
- Lint-staged is listed in `devDependencies` but there is no `lint-staged` config in `package.json`. No pre-commit hook is wired.
- Editor settings in `.vscode/settings.json` associate `*.xian` files with the `html` language and disable Copilot and inline suggestions. Do not rely on editor autocomplete.

**Modules:**
- The project is ES modules: `"type": "module"` in `package.json`. Use `import`/`export` only. Node `>=24` is required (`engines`).
- Always include the `.js` extension on relative imports: `import { RouteBuilder } from "../src/RouteBuilder.js";`.
- Use `node:` prefixed built-ins where the file is new: `import path from "node:path";` (`src/app.js`, `src/xian/engine.js`). Older scripts use bare names (`src/scripts/utils.js` imports `"fs/promises"`). Prefer `node:`.
- Use the `* as` namespace import for Zod and Drizzle MySQL core: `import * as z from "zod";` (`app/http/requests/auth/loginRequest.js`), `import * as t from "drizzle-orm/mysql-core";` (`app/models/users.js`).
- Use `import 'dotenv/config';` at the top of entry points that need environment variables (`src/server.js`, `drizzle.config.js`, `database/database.js`).

## Import Organization

**Order (as observed in `src/app.js` and `app/http/controllers/authController.js`):**
1. Third-party packages (`express`, `argon2`, `uuid`, `zod`, `drizzle-orm/...`).
2. Node built-ins (`node:path`, `node:url`) — these are often interleaved with (1) in older files; group them with `node:` first when editing.
3. Local config (`../../../config/cryptography.js`).
4. Local request validators, controllers and routers, separated by a `// REQUESTS` or similar comment in `app/http/controllers/authController.js`.

**Path Aliases:**
- None configured. There is no `jsconfig.json` or `tsconfig.json` path mapping. Use relative paths with `.js` extensions.
- `database/database.js` imports `'../app/models/relations/relations'` without the `.js` extension. Do not repeat this. Add `.js`.

## Error Handling

**Request validation (`app/http/requests/`):**
- Each validator is a function `(req) => data | errorIssues` built on Zod. The pattern is in `app/http/requests/auth/loginRequest.js`:
  ```js
  export const loginRequest = (req) => {
    const data = { email: req.body.email, password: req.body.password };
    const Login = z.object({ email: z.string(), password: z.string() });
    try {
      Login.parse(data);
      return data;
    } catch (error) {
      if (error instanceof z.ZodError) {return error.issues;}
    }
  };
  ```
- The return shape is inconsistent. `loginRequest` returns `error.issues` (an array), while `app/http/requests/auth/registerRequest.js` returns `{ error: error.issues }`. Pick one shape for new validators. The recommended shape is `{ error: error.issues }` so callers can check `"error" in result`.
- When the `catch` branch is not a `ZodError`, the function returns `undefined` silently. New code must rethrow non-Zod errors: `throw error;`.
- Validators must not use `req.body.x.trim()` without a null guard. `registerRequest.js` calls `.trim()` directly on `req.body.name`, which throws a `TypeError` when the field is missing.
- Use `z.int()` for numeric route params as in `app/http/requests/singleResourceRequest.js`. Note that `z` is not imported in that file (see CONCERNS).

**Controllers:**
- Express handlers respond with `res.render`, `res.json`, `res.redirect` or `res.send`. Use `return` after responding to avoid double-send: `if (!req.session.userId) {return res.redirect("/login");}` (`app/http/controllers/authController.js`).
- Auth-gated pages check `req.session.userId` inline. There is no auth middleware yet.
- Async controllers should `try/catch` around DB calls and call `next(error)`. No controller in `app/` currently does this; `app/http/controllers/userController.js` `index` contains a `res.render` with hardcoded data and a stray `insert.data(data)` call that will throw.

**Bootstrap and CLI:**
- Top-level async entry points catch and set an exit code: see `src/server.js`:
  ```js
  startServer().catch((error) => {
    console.error("❌ Failed to start XianFire:", error);
    process.exitCode = 1;
  });
  ```
- CLI generators log and exit with status: `src/scripts/create/index.js` uses `console.error(...)` then `process.exit(1)`.

**Template engine errors:**
- `src/xian/errors.js` defines `XianTemplateError` with `templatePath`, `line`, `column` and `cause`. Wrap Handlebars errors with `createTemplateError(error, templatePath)` (see `src/xian/engine.js`). Throw `XianTemplateError` for engine-level failures, do not throw bare `Error`.
- Helpers that receive bad input return an empty string rather than throwing: `views/helpers/currency.js` returns `""` when `Number.isFinite` fails.
- Helper modules must default-export a function. `src/xian/helpers.js` throws `TypeError` when they do not.

## Logging

**Framework:** `console` only. No logger library is installed (`package.json` has no pino, winston or morgan).

**Patterns:**
- Startup messages use emoji prefixes: `console.log(`🔥 XianFire running at http://localhost:${PORT}`)` and `console.error("❌ ...")` in `src/server.js`. Keep this style for CLI and bootstrap messages.
- Request logging middleware `app/http/middleware/requestLoggerMiddleware.js` is an empty file. Do not assume request logs exist.
- Do not log secrets. `.env.example` lists `SECRET_KEY` and database credentials; never print `process.env` values.

## Comments

**When to Comment:**
- Use `//` comments for section labels and to explain intent, e.g. `// Generated by the application on insert, not by a database DEFAULT.` in `app/models/helpers/uuid.js` and `// Matches the supplied view: includes past-expiry batches and all statuses.` in `app/models/inventory-views.js`.
- Use `// (FOR ENGINE)` or `// (FOR APPLICATION)` tags to mark which side of a module boundary a function belongs to (`src/xian/helpers.js`, `src/xian/index.js`).
- Commented-out code is common in controllers (`//const match = await argon2.compare(...)`). Do not add new commented-out code; delete it or leave a `TODO`.
- `//! WIP...` marks unfinished framework code in `src/RouteBuilder.js`.

**JSDoc/TSDoc:**
- JSDoc is used on request validators: `@param {object} req // Express.js` and `@returns {object}` in `app/http/requests/auth/loginRequest.js`. Use the same format for new validators.
- No type checking is configured; JSDoc is documentation only.

## Function Design

**Size:** Small factory-style functions. Controllers are objects of handlers. `src/xian/engine.js` is the largest file and nests helpers inside `createXianEngine`.

**Parameters:**
- Express handlers take `(req, res)` or `(_req, res)` when `req` is unused. Use the underscore prefix for unused parameters.
- Configuration is passed as a single destructured options object with defaults: `createXianEngine({ partialsDirectory, ..., strict = environment === "development", ... })` in `src/xian/engine.js`.
- Put defaulted parameters last (`default-param-last` rule). `RouteBuilder.resource(uri, controllerObject, handlers = {...})` in `src/RouteBuilder.js` follows this.

**Return Values:**
- Route helpers return `res.json(...)` or `res.render(...)` directly. Chain `.status()` after `.json()` is used in `app/http/controllers/api/v1/healthController.js` and `app/http/controllers/userController.js`, but Express calls `.status()` before `.json()` by convention. Use `res.status(201).json({...})`.
- Validators return either the validated data or an error value (see Error Handling).

## Module Design

**Exports:**
- Controllers: default export of an object with named handler keys: `export default { ... }` (`app/http/controllers/userController.js`, `app/http/controllers/authController.js`).
- Single handlers: named export: `export const homePage = (req, res) => {...}` (`app/http/controllers/homeController.js`).
- Validators: named export of a function (`export const loginRequest`) or default export (`app/http/requests/user/getUserRequest.js` exports `export default () => {};`). Prefer named exports.
- Drizzle models: named export of the table, e.g. `export const users = t.mysqlTable(...)`. Helper modules default-export the timestamp object: `export default { createdAt, updatedAt }` in `app/models/helpers/timestamps.js`, spread into table definitions as `...timestamps`.
- Model relations: a single `defineRelations` call in `app/models/relations/relations.js` imports every model. Register new models there.

**Barrel Files:**
- Only `src/xian/index.js` is a barrel: it re-exports `createXianEngine` and `XianTemplateError`. Other folders import the file directly.

**Routes:**
- Route registration: `routes/web.js` and `routes/api_v1.js` create an `express.Router()`, attach handlers, and export the router. `routes/routes.js` mounts them under `/` and `/api/v1`. Add new route groups to the `routeGroups` array.
- Resource routes use `RouteBuilder`: `routeBuilder.resource("/users", userController)` (`routes/web.js`). Use `apiResource` for JSON-only resources.

## Database Schema Conventions (Drizzle MySQL)

These apply to every file in `app/models/`:
- Primary keys: `id: uuidPrimaryKey()` from `app/models/helpers/uuid.js`. The value is generated in the app with `randomUUID` (`$defaultFn`), not by a DB default.
- Foreign keys: `uuid("<table>_id")` from the same helper, which is `CHAR(36)` with `ascii_bin` collation.
- Timestamps: spread `...timestamps` from `app/models/helpers/timestamps.js`. Every table gets `created_at` and `updated_at` (with `onUpdateNow`).
- Money fields: `t.decimal({ precision: 14, scale: 2 }).notNull().default("0")`, as in `app/models/sales.js`. Do not use floats.
- Constraints go in the second argument as `(table) => [ ... ]`, with `foreignKey(...).onUpdate("cascade").onDelete("...")` and explicit `check(...)` where needed.
- Naming: see Naming Patterns above.

## Frontend (Xian templates)

- Templates are Handlebars with the `.xian` extension (`views/**/*.xian`). Pages live in `views/pages/`, shared shells in `views/layouts/`, reusable fragments in `views/partials/`.
- Pages use the `<section>` root with Tailwind utility classes: `<section class="border bg-white flex flex-col items-center p-3 h-full gap-2">` (`views/pages/users.xian`).
- Include partials with `{{>partialName}}` (`views/pages/users.xian` includes `{{>userTable}}`).
- Use `res.render("auth/login", { pageTitle: "Login" })` with the path relative to `views/pages/` and no extension (`app/http/controllers/authController.js`).
- The engine runs in `strict` mode in development (`src/app.js`), so every referenced property must exist on the context object. Pass all variables explicitly.
- Handlebars escapes output by default. Use triple braces only for trusted HTML.
- See the project skill `.claude/skills/xian-view-engine/` (local, untracked) for detailed view-engine rules.

## Practical Rules For New Code

1. Use ES modules, `.js` extensions and `node:` built-ins.
2. Use double quotes, semicolons and 2-space indent.
3. Use braces for every control-flow body (`curly: all`).
4. Use block-bodied arrows with explicit `return` for object-returning functions.
5. Put a new controller in `app/http/controllers/`, export handlers from a default object, and add routes in `routes/web.js` or `routes/api_v1.js`.
6. Put a new validator in `app/http/requests/<area>/`, use Zod, return `{ error: error.issues }` on failure, and rethrow non-Zod errors.
7. Put a new model in `app/models/<kebab-name>.js`, use `uuidPrimaryKey()` and `...timestamps`, and register it in `app/models/relations/relations.js`.
8. Put a new Xian helper in `views/helpers/<name>.js` with a default export. The file name becomes the helper name.

---

*Convention analysis: 2026-11-12*
