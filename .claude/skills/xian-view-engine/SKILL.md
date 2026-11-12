---
name: xian-view-engine
description: "Build, change and debug the server-rendered UI of this project, which runs on the custom Xian view engine (src/xian; Handlebars templates in .xian files under views/ - pages, layouts, partials, helpers) with the Tailwind CSS v4 browser CDN, Bootstrap Icons CDN and SweetAlert2. Use it whenever a task touches views/, a .xian file, res.render(), a page, form, table, navbar, layout, partial, Handlebars helper, flash message, alert, toast, confirm dialog, icon or Tailwind styling, or shows an error such as 'Failed to render Xian template', 'The partial x could not be found' or 'x not defined in [object Object]' - even when the user never says Xian or view engine."
---

# Xian view engine

Every screen in this project is server-rendered by **Xian**, a thin wrapper around Handlebars (`hbs`) for Express 4, in `src/xian/`. Templates are `.xian` files under `views/`. There is no frontend build step: Tailwind CSS v4, Bootstrap Icons and SweetAlert2 all arrive from CDNs through one partial, `views/partials/head.xian`.

When docs and code disagree, trust the code. `docs/AI-generated/xian-template-engine-documentation.md` is a long conceptual write-up; for instance it prints `{{title}}` where the real `head.xian` prints `{{ pageTitle }}`.

## How a request becomes HTML

```text
res.render("auth/login", { pageTitle: "Login" })
 1. Express finds views/pages/auth/login.xian
 2. Xian renders it with { ...renderData, ...res.locals }      (res.locals wins on a key clash)
 3. that HTML becomes `body`; the layout ("main" unless told otherwise) renders with the same data + body
 4. layout = {{>head}} + <body> ... {{{body}}} ... </body></html>
```

| Piece | File | Used as | Rules |
| --- | --- | --- | --- |
| Page | `views/pages/<dir>/<name>.xian` | `res.render("<dir>/<name>", data)` | content only (no `<html>`/`<body>`); name is relative to `views/pages`, no extension |
| Layout | `views/layouts/<name>.xian` | default `main`; `layout: "<name>"` or `layout: false` in the render data | begin with `{{>head}}`, contain `{{{body}}}` once |
| Partial | `views/partials/<dir>/<name>.xian` | `{{> <dir>/<name>}}` | name = path under `partials` without `.xian`, forward slashes, unquoted |
| Helper | `views/helpers/<name>.js` | `{{name arg}}` | one per file, flat folder, `export default function`; restart the server after adding or editing |

`head.xian` opens the document (`<!DOCTYPE html><html><head>...</head>`) and holds every CDN tag, so a new third-party script or stylesheet goes there and nowhere else; the layout adds `<body>` and closes `</html>`.

Run the app with `npm run xian` (nodemon) or `npm start`, both through `src/server.js`, which builds the engine before listening (default http://localhost:3000). Never start `src/app.js` directly: it registers no engine. View work almost never needs edits in `src/xian/`.

## The render contract

- **Always pass `pageTitle`.** `head.xian` prints it in `<title>`; in development a missing one throws and the page returns 500. (Pages rendered with `layout: false` skip `head`.)
- `layout`: leave it out for `main`, give a bare layout name (`"authenticated"`), or `false` for no layout.
- **Pass every variable the template prints.** Development runs Handlebars in strict mode:

| Template | Data | Result in development |
| --- | --- | --- |
| `{{x}}`, `{{a.b}}` | property absent | throws `"x" not defined in [object Object]` (a present `null` is fine) |
| `{{a.b}}`, `{{#if a.b}}`, `{{#each a.list}}` | `a` absent or null | throws |
| `{{#if x}}` `{{#unless x}}` `{{#each x}}` `{{#with x}}` `{{helper x}}` | top-level `x` absent | fine (falsy / empty) |
| `{{title}}` inside `{{#each rows}}` | `title` lives on the page, not on a row | throws: use `{{../title}}` or `{{@root.title}}` |

  Production has strict mode off, so the same template quietly prints nothing there: a page can work in production and crash in development. Test in development. Send `null`, `""` or `[]` for "nothing", and guard optional nested objects with `{{#if user}}...{{/if}}`.
- `success_msg` and `error_msg` (flash arrays) exist in every template, set by `src/app.js`. Templates cannot see `req`, `res` or the session: expose what you need through `res.locals` (and set `null` when logged out).
- Do not name your own variables `settings`, `cache`, `_locals`, `layout` or `body`.

## Recipes

### New page
1. Create `views/pages/<area>/<name>.xian` with content only, in the house style (`references/tailwind-and-icons.md`).
2. Controller: `res.render("<area>/<name>", { pageTitle: "Products", products })` with every variable the page prints.
3. Route in `routes/web.js`. Standalone pages are `GET /<name>-page` (`/login-page`); REST resources use `routeBuilder.resource("/products", controller)`. Caveat: `resource()` registers `create` on the same URI as `index` and `edit` on the same URI as `show`, so those two handlers never run. Register create/edit page routes explicitly, before the `resource()` line.
4. Link it in the nav of `views/layouts/main.xian` when it needs a menu entry.
5. Run the checker and open the page in development (see Verify).

```hbs
<section class="border bg-white flex flex-col gap-3 p-4">
  <h1 class="text-xl font-bold"><i class="bi bi-capsule" aria-hidden="true"></i> Products</h1>
  {{#each products}}
    <p>{{name}} - {{currency price}}</p>
  {{else}}
    <p class="text-gray-500">No products yet.</p>
  {{/each}}
</section>
```

### Component (partial)
Put it in `views/partials/components/<name>.xian`, call it with `{{> components/<name> label="Save" icon="check-lg"}}`. Hash params become variables inside the partial, and it also sees the caller's context. Under strict mode a printed param that the caller omitted throws, so document required params in a comment and wrap optional ones in `{{#if}}`. A complete example (`components/button`) and the other partial forms (blocks, inline, dynamic) are in `references/handlebars-in-xian.md`.

### Helper
Create `views/helpers/<name>.js` with `export default function name(value, ...) {}`, then restart. Handlebars has no `eq`, `and`, `gt` or string concatenation, so `{{#if (eq role "admin")}}` fails until `eq.js` exists. A tested starter set (`eq`, `gt`, `and`, `or`, `not`, `formatDate`, `ifRole`, `badge`) is in `references/handlebars-in-xian.md`. The repo already has `currency` (PHP pesos), `json` and `uppercase`.

### Layout
Copy `views/layouts/main.xian`, keep `{{>head}}` first and `{{{body}}}` once, save as `views/layouts/<name>.xian`, select it with `layout: "<name>"`. Every partial a layout includes must exist: `authenticated.xian` includes `{{>sideNavBar}}` and that file does not exist (see Known issues).

### Forms and actions
- POST forms: `<form method="POST" action="/users">` with `name=` on inputs; `express.urlencoded` and `express.json` are on, so values arrive in `req.body`.
- After a successful action use Post/Redirect/Get with a flash message: `req.flash("success_msg", "User created"); res.redirect("/users");`. On failure `req.flash("error_msg", "Email is required")` and redirect back. To keep what the user typed, re-render the form instead and pass `values`/`errors` on every render of that page (strict mode).
- Browsers send only GET and POST from a form, and no method-override middleware is installed, so PATCH/PUT/DELETE go through `fetch` (the `data-fetch-method` attributes in `references/sweetalert.md`).
- There is no CSRF protection in the app yet; do not assume a token exists.

### Alerts, toasts, confirmations
Use SweetAlert2 through the `swal/init` partial: flash messages become toasts and error modals automatically, and `data-confirm="..."` on a form or link asks before it proceeds. SweetAlert2 may not be installed yet: check `views/partials/head.xian` and follow `references/sweetalert.md`, which also lists the HTML-versus-text options that cause XSS (`title` is HTML, `titleText` and `text` are not).

### Styling and icons
Tailwind utilities in `class`, shared CSS in `<style type="text/tailwindcss">` (never `tailwind.config.js` or the v3 CDN), icons as `<i class="bi bi-<name>" aria-hidden="true"></i>`. Read `references/tailwind-and-icons.md` for the house style, the cascade-layer rule, the v4 differences and a verified list of icon names.

## Gotchas that cost time

- `{{x}}` escapes; `{{{x}}}` is raw. Use triple braces only for trusted HTML (the layout's `{{{body}}}`).
- Handlebars also parses `<script>` and `<style>` inside a `.xian` file: any `{{` is a mustache (escape a literal one as `\{{`). To hand server data to browser JavaScript use `data-x="{{json value}}"` and `JSON.parse(el.dataset.x)`, never `{{{json value}}}` inside a script (a `</script>` in the value breaks out).
- Server-only comments are `{{!-- ... --}}`; `<!-- -->` is sent to the browser.
- An error inside a partial is reported with the path of the page or layout that included it, but with the line and column of the partial. Search the partial.
- `res.locals` beats `res.render` data for the same key.
- Tailwind v4: bare `border` is `currentColor` (black), `ring` is 1px, `bg-opacity-*` is gone (use `bg-black/50`), unknown classes such as `text-xxl` silently do nothing, and unlayered CSS (`.btn` in `main.xian`, SweetAlert2) beats utilities.
- Only Bootstrap *Icons* is loaded. Bootstrap CSS classes (`btn-primary`, `col-md-6`, `d-flex`) do not exist; `.btn` is this project's own class.
- Page routes end in `-page` (`/login-page`, `/register-page`, `/dashboard-page`); links and redirects must use those.

## Verify

```bash
node .claude/skills/xian-view-engine/scripts/check-views.mjs
```

Run it from the project root after any change under `views/` or any `res.render`. It needs no install, and uses the real Handlebars parser when `node_modules` exists. It reports partials, helpers and layouts that do not exist, layouts without `{{{body}}}`, `res.render` calls with a missing page or no `pageTitle`, unbalanced blocks, helper files without a default export, and raw `{{{ }}}` output. Exit code 1 means errors.

The checker is static, so also load the page for real: `npm run xian`, open the route in development (strict mode is the real test) and look at the browser console for CDN or 404 errors. If the app cannot start for unrelated reasons (dependencies, env), render through the engine directly with the snippet in `references/engine-internals.md`.

## Known issues in the repo (snapshot 2026-11-12, re-check before relying on them)

- `views/layouts/authenticated.xian` includes `{{>sideNavBar}}`, but `views/partials/sideNavBar.xian` does not exist: any render with `layout: "authenticated"` throws.
- SweetAlert2 is not loaded in `head.xian` yet (the intended stack includes it).
- `main.xian` puts its `<style type="text/tailwindcss">` block after `</html>`. Browsers tolerate it; when you next edit the file, move it into `<head>` or before `</body>`. Its `.btn` is unlayered CSS, so utilities cannot override it on the same element.
- `text-xxl` in `main.xian` and `home.xian` is not a Tailwind class (no effect).
- Auth pages link to URLs that are not GET routes: `login.xian` links `/register`, `register.xian` and `forgotpassword.xian` link `/login`, and `authController` redirects to `/login` and `/dashboard`. The routes are `/register-page`, `/login-page`, `/dashboard-page`.
- `RouteBuilder.resource()` shadows `create` and `edit` (see New page).
- `Dockerfile.prod` runs `node src/app.js`, which never builds the engine or listens; the production image should run `src/server.js`.

## Reference files (read only what the task needs)

- `references/handlebars-in-xian.md`: syntax cheat sheet with strict-mode behavior, partial forms, data-to-JavaScript pattern, helper rules and the tested starter helpers and component.
- `references/tailwind-and-icons.md`: how the Tailwind browser build loads, custom CSS and the layer rule, house style, v4 differences, Bootstrap Icons usage and a verified icon list.
- `references/sweetalert.md`: install steps, the `swal/init` flash and confirm system, recipes (delete with fetch, confirm forms), HTML-versus-text safety table, Tailwind styling rules, testing notes.
- `references/engine-internals.md`: `createXianEngine` options, render pipeline, hot-reload and cache matrix, error message catalog, engine quirks, rendering without a server.
- `assets/swal/init.xian`: the SweetAlert2 glue partial to copy into `views/partials/swal/init.xian`.
- `scripts/check-views.mjs`: the static checker described above.
