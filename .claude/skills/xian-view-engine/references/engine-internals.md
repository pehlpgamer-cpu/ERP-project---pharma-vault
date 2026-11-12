# Xian engine internals

Read this when you have to change `src/xian/*`, when an error is not explained in `SKILL.md`, or when you need the exact rules for caching, hot reload and data merging. Everything here was checked by running the repo's own engine (hbs 4.3.1, Handlebars 4.7.9, Express 4.22.3), not only by reading the code.

## Contents
- Wiring
- `createXianEngine` options
- Render pipeline
- Hot reload and caching
- Error messages and what they mean
- Behaviors that surprise people
- Rendering without a server

## Wiring

`src/server.js` calls `await bootstrap()` from `src/app.js`, and only then `app.listen`. `bootstrap()` runs `createXianEngine(...)`, then `app.engine("xian", xian.engine)`, `app.set("views", views/pages)` and `app.set("view engine", "xian")`.

- Start the app through `src/server.js` (`npm start`, or `npm run xian` for nodemon). `src/app.js` alone exports the Express app but registers no engine and never listens.
- `src/app.js` also copies `req.flash("success_msg")` / `req.flash("error_msg")` into `res.locals.success_msg` / `res.locals.error_msg` (arrays) on every request, so every template can read them.
- `express.static` serves `<cwd>/public`. That folder does not exist yet; create it if you need local CSS/JS/images (URL `/css/app.css` maps to `public/css/app.css`).

## `createXianEngine` options

| Option | Default | Meaning |
| --- | --- | --- |
| `partialsDirectory`, `layoutsDirectory`, `helpersDirectory` | required | absolute paths |
| `environment` | `NODE_ENV ?? "development"` | only used to derive the three defaults below |
| `defaultLayout` | `"main"` | layout used when render data has no `layout` key |
| `strict` | `environment === "development"` | Handlebars strict mode (see SKILL.md for the exact rules) |
| `watch` | `environment === "development"` | chokidar watcher on partials, layouts and helpers |
| `cache` | `environment === "production"` | keep compiled page and layout functions in memory |

It returns `{ engine, hbs, handlebars, templateCache, invalidateTemplate, close }`. `await xian.close()` stops the watcher (use it in tests and on shutdown). `xian.handlebars` is a private instance created with `hbs.create()`, so anything registered on it affects Xian only.

## Render pipeline (`src/xian/engine.js`)

1. Express calls `engine(filePath, options, callback)`. `options` is `app.locals`, then `res.locals`, then the data passed to `res.render`, plus Express extras (`settings`, `cache`, `_locals`).
2. `templateData = { ...options, ...options._locals }`. `_locals` is `res.locals`, spread last, so **`res.locals` wins over `res.render` data** when both define the same key.
3. The page is compiled (cached in production) and rendered with `templateData`.
4. Layout choice: `layout: false` means none, otherwise `options.layout ?? defaultLayout`. With none, the page HTML is the response.
5. The layout file `views/layouts/<name>.xian` is resolved (missing file throws `Xian layout "<name>" was not found at "<path>".`), compiled and rendered with `{ ...templateData, body: pageHtml }`.
6. Any failure becomes a `XianTemplateError` (`.templatePath`, `.line`, `.column`, `.cause`) passed to `callback`, so Express `next(err)` handles it (stack trace page in development, plain 500 in production). There is no custom error view.

Partials are registered once at startup as raw strings (`handlebars.registerPartial(name, source)`) and compiled lazily by Handlebars the first time they run, with the same `strict` flag as the page. Helpers are loaded once at startup with a dynamic `import()`.

## Hot reload and caching

| You change | Development (`strict`, `watch`, no cache) | Production (cache, no watcher) |
| --- | --- | --- |
| a page `views/pages/**` | next request (pages are re-read every time) | not seen until restart |
| a layout | next request | restart |
| a partial | watcher re-registers it, next request | restart |
| add or delete a partial | registered / unregistered by the watcher, `{{> new/name}}` works at once | restart |
| a helper `views/helpers/*.js` | **not reloaded** (ES module imported once): restart. nodemon restarts on any `.js` change, so `npm run xian` does it for you | restart |
| `src/xian/*.js`, `src/app.js` | restart (automatic under nodemon) | restart |

## Error messages and what they mean

| Message (abridged) | Cause | Fix |
| --- | --- | --- |
| `"role" not defined in [object Object] - 17:36` | strict mode: `{{role}}` or `{{a.role}}` and the property is absent on that object | pass the key from the controller (`null`, `""` or `[]` are fine), or wrap in `{{#if role}}...{{/if}}`. `17:36` is line:column **inside the file that holds the mustache**, which can be a partial even though the message names the page or layout |
| `"name" not defined in undefined` (or `null`) | `{{user.name}}` and `user` is absent or null | `{{#if user}}{{user.name}}{{/if}}` |
| `Cannot read properties of undefined (reading 'name')` | a dotted path used as an argument (`{{#if user.name}}`, `{{#each user.items}}`, `(eq user.role "a")`) with an absent or null parent. No line number | guard the parent first |
| `"foo" not defined in [object Object]` for `{{foo 1}}` or `{{#foo x}}` | unknown helper (strict wording; production says `Missing helper: "foo"`) | create `views/helpers/foo.js`, restart |
| `The partial sideNavBar could not be found` | no `views/partials/sideNavBar.xian`. No line number | create it or fix the name (folders count: `components/card`) |
| `Xian layout "x" was not found at "..."` | `layout: "x"` with no `views/layouts/x.xian` | fix the name; pass the bare name, not a path |
| `Parse error on line N: ...` | Handlebars syntax error (unclosed block, stray `{{`) | `check-views.mjs` shows it with line numbers when deps are installed |
| `Helper "<file>" must export a function.` | startup crash from `registerHelpers` | `export default function name(...) {}` |
| `Failed to lookup view "x" in views directory ".../views/pages"` | Express cannot find `views/pages/x.xian` | file name or case |
| `No default engine was specified and no extension was provided.` | the engine was never registered: the process was started from `src/app.js` instead of `src/server.js` | start through `src/server.js` |

## Behaviors that surprise people

- **`res.locals` beats render data** for the same key. Do not set `res.locals.pageTitle` globally and also pass `pageTitle` to `res.render` expecting the second to win.
- Templates see `settings`, `cache`, `_locals` and `layout` as variables. They do not see `req`, `res` or `session`; expose what you need through `res.locals` (and set `null` when logged out, because strict mode throws on an absent key).
- **Strict mode exists only in development.** Production prints empty strings for missing values, so a page can be fine in production and crash in development. Always render once in development.
- A missing partial only fails when that line actually runs, e.g. inside a branch the test data did not take. `scripts/check-views.mjs` checks every `{{> name}}` statically.
- The development watcher registers every `.xian` file added or changed under `views/layouts/` as a partial named `../layouts/<name>`. Harmless noise in the registry.
- `{{{body}}}` in a layout is the only place raw output is expected; everything else should use `{{ }}`. Escaping can't be turned off globally (`noEscape: false`).

## Rendering without a server

Useful for a quick check or a test, because it uses the real engine in strict mode:

```js
import path from "node:path";
import { createXianEngine } from "./src/xian/index.js";

const views = (dir) => path.resolve("views", dir);
const xian = await createXianEngine({
  partialsDirectory: views("partials"),
  layoutsDirectory: views("layouts"),
  helpersDirectory: views("helpers"),
  environment: "development", strict: true, watch: false, cache: false,
});

const html = await new Promise((resolve, reject) =>
  xian.engine(views("pages/users.xian"), { pageTitle: "Users", success_msg: [], error_msg: [], users: [] }, (err, out) =>
    err ? reject(err) : resolve(out),
  ),
);
await xian.close();
```

This needs `npm install` first (`hbs`, `chokidar`). Pass `layout: false` in the data to get just the page.
