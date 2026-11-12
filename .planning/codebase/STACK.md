---
last_mapped_commit: 6c68bfc8c9a017230b3402686dfa921da03104f7
last_mapped_at: 2026-11-12
---
# Technology Stack

**Analysis Date:** 2026-11-12

## Languages

**Primary:**
- JavaScript (ES modules, `"type": "module"` in `package.json`) - all application code under `app/`, `config/`, `database/`, `routes/`, `src/`, `bin/`, `views/helpers/`, `tests/`
- Handlebars (`.xian` files) - server-rendered templates in `views/pages/`, `views/layouts/`, `views/partials/`
- SQL - generated MySQL migrations in `database/migrations/*/migration.sql`

**Secondary:**
- TypeScript (declarations only) - generated Drizzle schema and relations in `database/migrations/schema.ts` and `database/migrations/relations.ts`. No `tsconfig.json` is present and nothing compiles TypeScript.
- HTML/CSS - page shell in `views/partials/head.xian`, base styles in `views/partials/css/base.xian`
- YAML - Docker Compose files `compose.dev.yaml`, `compose.prod.yaml`

## Runtime

**Environment:**
- Node.js `>=24` (declared in `package.json` `engines`)
- Docker base images: `node:24-bookworm-slim` in `Dockerfile.prod`, `node:24` service in `compose.dev.yaml`
- No `.nvmrc` or `.node-version` file is present

**Package Manager:**
- npm
- Lockfile: present (`package-lock.json`, `lockfileVersion: 3`)
- Dependencies are not installed in this checkout (`node_modules/` absent). Versions below come from `package-lock.json`.

## Frameworks

**Core:**
- Express `4.22.3` (lock; manifest `^4.19.2`) - HTTP server, entry in `src/app.js`, listener in `src/server.js`
- Xian view engine (custom, in-repo) - `src/xian/` (`engine.js`, `helpers.js`, `partials.js`, `layouts.js`, `watcher.js`, `errors.js`). Built on an isolated `hbs` instance.
- Handlebars via `hbs` `4.3.1` - template rendering inside the Xian engine (`src/xian/engine.js`)
- Drizzle ORM `drizzle-orm` `1.0.0-rc.4` with the `mysql2` driver - schema in `app/models/*.js` (uses `drizzle-orm/mysql-core`), connection in `database/database.js`
- Session and flash middleware: `express-session` `^1.17.3`, `connect-flash` `^0.1.1` (wired in `src/app.js`)

**Testing:**
- Japa test runner `@japa/runner` `^5.3.0`, with plugins `@japa/expect`, `@japa/expect-type`, `@japa/api-client`, `@japa/browser-client`, `@japa/snapshot`, `@japa/assert`, `@japa/file-system` (devDependencies). Runner config in `bin/test.js`. Suites in `tests/unit/`, `tests/feature/`, `tests/browser/`.
- Playwright `^1.63.0` (devDependency) - used by the browser-client suite

**Build/Dev:**
- `nodemon` `^3.1.14` - dev server (`npm run xian`)
- `concurrently` `^8.2.2` - used by `dev:electron` and `run` scripts
- `oxlint` `^1.83.0` - linting, config `.oxlintrc.json`
- `oxfmt` `^0.68.0` - formatting, config `.oxfmtrc.json`
- `dependency-cruiser` `^17.4.3` - dependency graph checks, config `.dependency-cruiser.cjs`
- `drizzle-kit` `1.0.0-rc.5-ab785fc` (lock; manifest `^1.0.0-rc.4`) - migration generation, config `drizzle.config.js`
- `lint-staged` `^17.5.1` (devDependency; no lint-staged config found in `package.json`)
- `editorconfig` `^3.0.2` (dependency) - `.editorconfig` present at repo root
- `electron` `^28.0.0` and `electron-builder` `^24.9.1` (devDependencies) - see Configuration/Concerns: the Electron entry point is missing

## Key Dependencies

**Critical:**
- `express` `4.22.3` - the whole web layer (`src/app.js`, `routes/web.js`, `routes/api_v1.js`)
- `drizzle-orm` `1.0.0-rc.4` - ORM used by all table definitions in `app/models/` (41 `drizzle-orm/mysql-core` imports)
- `mysql2` `3.24.4` - MySQL driver consumed by Drizzle via `database/database.js`
- `hbs` `4.3.1` - Handlebars engine backing `.xian` templates
- `argon2` `0.45.1` - password hashing in `app/http/controllers/authController.js`
- `zod` `4.6.5` - request validation schemas in `app/http/requests/auth/loginRequest.js` and `registerRequest.js`
- `express-session` `^1.17.3` - session state (`req.session.userId`)
- `chokidar` `5.0.0` - file watcher for template hot-reload, used only in `src/xian/watcher.js` (dev mode)
- `uuid` `14.0.2` - `v4` ids in `app/http/controllers/authController.js`
- `dotenv` `^17.4.2` - loaded via `import 'dotenv/config'` in `src/server.js` and `database/database.js`

**Declared but not referenced in application source:**
- `bcrypt` `5.1.1` (lock) - no `import` found in `app/`, `src/`, `config/`, `routes/`, `database/`; argon2 is used instead
- `sequelize` `6.37.8` (lock) - the only mention is an import in the code generator `src/scripts/create/model.js`, and a commented-out import in `app/http/controllers/auditTrailController.js`
- `inquirer` `^9.2.15` - no import found in tracked source
- `drizzle-seed` `^1.0.0-rc.4` - no import found in tracked source
- `studio` `^0.13.5` - no import found in tracked source
- `jsx` `0.9.89` (devDependency) - no import found in tracked source

**Infrastructure:**
- `cookie`/session storage: none configured. `express-session` runs with its default in-memory store (`src/app.js`).
- `electron` `28.3.3` (lock) - not used by any tracked application code

## Configuration

**Environment:**
- Loaded with `dotenv` from a root `.env` file (not present in this checkout). Template: `.env.example`.
- Variables read by code (names only):
  - `NODE_ENV` - `src/app.js`, `src/server.js`, `src/xian/engine.js` (`development` enables strict mode, watcher; `production` enables template cache)
  - `PORT` - default `3000`, `src/server.js`
  - `SECRET_KEY` - session secret (default `development-secret`) in `src/app.js`; also used as the password pepper in `app/http/controllers/authController.js`
  - `PROD_MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_NAME` - MySQL connection URL built in `database/database.js`
  - `ARGON2_TYPE`, `ARGON2_MEMORY_COST`, `ARGON2_HASH_LENGTH`, `ARGON2_PARALLELISM` - read in `config/cryptography.js` (no `ARGON2_TIME_COST` read)
- Mismatches to note:
  - `.env.example` defines `MYSQL_DATABASE` and `MYSQL_USER`, but `database/database.js` reads `MYSQL_NAME` and `PROD_MYSQL_USER`. `.env.example` also does not define `MYSQL_HOST` or `MYSQL_PORT`.
  - `.env.example` defines `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `MAIL_*`, and `ARGON2_TIME_COST`, but no tracked code reads them.
- `config/app.js` is empty. `config/database.js` exports empty `development` and `production` objects and is not imported.

**Build and tooling:**
- `drizzle.config.js` - Drizzle Kit: dialect `mysql`, schema `./app/models`, output `./database/migrations`, `casing: 'snake_case'`, `strict: true`. Its `dbCredentials` are hard-coded to `localhost:3306` with a literal root user and password rather than read from env.
- `.oxlintrc.json`, `.oxfmtrc.json` - lint and format configuration
- `.dependency-cruiser.cjs` - architecture rules
- `.editorconfig` - editor formatting
- `.vscode/settings.json` - editor settings
- `.devcontainer/devcontainer.json` - VS Code dev container. Uses `../compose.dev.yaml`, runs `npm ci` on create, forwards port 3000.
- `.devcontainer/devcontainer-lock.json` - pins the `ghcr.io/devcontainers/features/git` feature

**Front-end assets (loaded from CDN at runtime, no local build):**
- Tailwind CSS v4 browser build: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4` in `views/partials/head.xian`
- Bootstrap Icons `1.13.1`: `https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css` in `views/partials/head.xian`
- Bootstrap CSS/JS and SweetAlert2 are not referenced in `views/`
- No `public/` directory exists in the checkout; `src/app.js` serves `process.cwd()/public` as static files, which currently resolves to nothing

## Scripts (from `package.json`)

- `npm start` - `node ./src/server.js` (production-style start)
- `npm run xian` - `nodemon ./src/server.js` (dev)
- `npm test` - `node bin/test.js; npm run test:dep`. `test:dep` is not defined in `package.json`.
- `npm run lint`, `npm run lint:fix`, `npm run fmt`, `npm run fmt:check` - oxlint and oxfmt
- `npm run dep:check`, `dep:svg`, `dep:report`, `dep:matrix` - dependency-cruiser
- `npm run create:model|controller|request` - `src/scripts/create/index.js`
- `npm run route:list`, `npm run route:cache` - `src/scripts/list-routes.js`, `src/scripts/route-cache.js`
- `npm run migrate`, `migrate:fresh`, `migrate:drop` - **target files are missing** (`src/scripts/migrate/*.js` do not exist)
- `npm run electron`, `dev:electron`, `run`, `build`, `dist` - Electron/electron-builder, see Concerns
- `bin/xian.js` (CLI `xian`) - maps aliases such as `s`/`start`, `d`/`dev`, `m`/`migrate` onto the npm scripts above

## Platform Requirements

**Development:**
- Node.js 24+
- npm
- MySQL 8.4 (see `compose.dev.yaml`; the checkout has no MySQL client config beyond `.env`)
- Redis 8.10.2 is provisioned by `compose.dev.yaml` but no Redis client is in dependencies
- Docker/Docker Compose for the dev container
- A `.env` file created from `.env.example`

**Production:**
- Container image: `Dockerfile.prod` - `node:24-bookworm-slim`, `npm ci --omit=dev`, runs as user `node`, exposes port 3000, `CMD ["node", "src/app.js"]`
  - `src/app.js` exports the Express app and does not call `listen()`, so this CMD starts a process that never serves HTTP. The listener is in `src/server.js`.
- `compose.prod.yaml` is incomplete: `version: "5.5.1"` is not a valid Compose version, and the `backend`, `mysql`, and `redis` services have no definitions.
- Electron build output (`dist/`) is not part of the web deployment.

---

*Stack analysis: 2026-11-12*
