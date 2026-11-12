# Handlebars as used in Xian templates

Syntax and idioms for `.xian` files, with the strict-mode behavior of this project's engine (Handlebars 4.7.9). Every snippet below was rendered through the real engine in development (strict) mode.

## Contents
- Output and escaping
- Conditionals and loops
- Paths and strict mode
- Partials
- Comments, whitespace and literal braces
- Server data in browser JavaScript
- Helpers (with a starter set)
- What templates cannot do

## Output and escaping

| Syntax | Result |
| --- | --- |
| `{{value}}` | escaped: `& < > " ' ` and `=` become `&amp; &lt; &gt; &quot; &#x27; &#x60; &#x3D;`. Safe in text and in quoted attributes |
| `{{{value}}}` or `{{&value}}` | raw. Only for markup you control: the layout's `{{{body}}}` and helpers that build HTML |

A helper that returns a plain string is escaped like any other value. To return HTML, return an object with a `toHTML()` method (no import needed) and escape the dynamic parts yourself, as the `badge` helper below does.

## Conditionals and loops

```hbs
{{#if user}}Hi {{user.name}}{{else if guest}}Guest{{else}}Please log in{{/if}}
{{#unless items}}nothing here{{/unless}}

{{#each users}}
  {{@index}}. {{username}}{{#unless @last}},{{/unless}}
{{else}}
  No users yet.
{{/each}}

{{#each totals}}{{@key}} = {{this}}{{/each}}   {{!-- objects iterate with @key --}}
{{#with order.customer}}{{name}}{{/with}}
{{lookup items 0}}   {{lookup person "first-name"}}
```

- Falsy for `if`/`unless`: `false`, `undefined`, `null`, `""`, `0` and `[]`. A numeric `0` is falsy, so use `{{#if qty includeZero=true}}` when zero is a real value.
- Inside `each`: `this`, `@index`, `@first`, `@last`, `@key` (objects), `../x` for the parent context, `@root.x` for the top-level data.
- There are no comparison or boolean operators. `{{#if (eq role "admin")}}` needs `views/helpers/eq.js` (starter set below).

## Paths and strict mode

Development runs with `strict: true`; production does not. The rules, as observed:

| Template | Missing or null data | Result in development |
| --- | --- | --- |
| `{{title}}`, `{{user.name}}` | property absent | throws `"title" not defined in [object Object]` |
| `{{user.name}}` | `user` absent or null | throws `"name" not defined in undefined` / `in null` |
| `{{user.name}}` | `user: { name: null }` | prints nothing (present-but-null is fine) |
| `{{#if x}}`, `{{#unless x}}`, `{{#each x}}`, `{{#with x}}`, `{{helper x}}` | top-level `x` absent | fine: falsy / empty / `undefined` argument |
| `{{#if user.name}}`, `{{#each user.items}}`, `(eq user.role "a")` | `user` absent or null | throws `Cannot read properties of undefined (reading 'name')` |
| `{{#each users}}{{title}}{{/each}}` | `title` is on the page data, not on each user | throws: no implicit parent lookup. Use `{{../title}}` or `{{@root.title}}` |

Habits that follow from this: pass every variable a template prints (use `null`, `""`, `[]` for "nothing"); guard optional nested objects with `{{#if user}}...{{/if}}` before dereferencing; use `{{lookup obj "key"}}` when a key may not exist.

Keys with odd characters use brackets: `{{[my-key]}}`, `{{obj.[a b]}}`. Array length is `{{items.length}}`.

## Partials

```hbs
{{> head}}                                         {{!-- views/partials/head.xian --}}
{{> components/card title="Hi" price=10}}          {{!-- hash params become variables inside the partial --}}
{{> components/card user title="Hi"}}              {{!-- context argument: the partial sees `user` as this, plus the hash --}}
{{#> components/panel}}inner html{{/components/panel}}   {{!-- partial block; the partial prints {{> @partial-block}} --}}
{{#*inline "row"}}<tr>{{name}}</tr>{{/inline}}
{{#each users}}{{> row}}{{/each}}                  {{!-- inline partial: this file only --}}
{{> (lookup . "which")}}                           {{!-- dynamic partial name --}}
```

- The name is the file path under `views/partials`, without `.xian`, with forward slashes and no quotes: `views/partials/components/card.xian` is `components/card`.
- A partial inherits the caller's context, so it can read the page's variables; hash params override them.
- Strict mode: a partial that prints `{{label}}` throws when the caller left `label` out. Document required params at the top of the partial and wrap optional ones in `{{#if}}`.

Reusable component example (`views/partials/components/button.xian`):

```hbs
{{!-- components/button: <a> when href is given, otherwise <button>. Required: label. Optional: icon, href, type. --}}
{{#if href}}
<a href="{{href}}" class="btn inline-flex items-center gap-2">
  {{#if icon}}<i class="bi bi-{{icon}}" aria-hidden="true"></i>{{/if}}{{label}}
</a>
{{else}}
<button type="{{#if type}}{{type}}{{else}}button{{/if}}" class="btn inline-flex items-center gap-2">
  {{#if icon}}<i class="bi bi-{{icon}}" aria-hidden="true"></i>{{/if}}{{label}}
</button>
{{/if}}
```

Used as `{{> components/button label="Save" icon="check-lg" type="submit"}}` or `{{> components/button label="Users" href="/users"}}`.

## Comments, whitespace and literal braces

- Server-only comment: `{{!-- note --}}`. Use this form whenever the note contains braces or mustaches; the short `{{! note }}` stops at the first `}}`. An HTML comment `<!-- -->` is sent to the browser.
- `{{~x~}}` trims the whitespace on that side of the tag.
- Inline `<script>` and `<style>` inside a `.xian` file are parsed by Handlebars too. Single braces and a lone `}}` are fine (`fn({a:{b:1}})`, CSS rules), but any `{{` is a mustache: `'{{x}}'` inside JavaScript is replaced by the server value.
- To print a literal `{{name}}` (client-side templates, Alpine, Vue) escape it: `\{{name}}`. There is no `raw` helper, so `{{{{raw}}}}` blocks do not work here.

## Server data in browser JavaScript

Put the data in an attribute and parse it:

```hbs
<div id="stock-chart" data-points="{{json points}}"></div>
<script>
  const points = JSON.parse(document.getElementById('stock-chart').dataset.points);
</script>
```

`{{json x}}` is HTML-escaped (`&quot;`), which is exactly right inside an attribute because the browser decodes it back. Do not move it into the script body: `{{json x}}` there yields `&quot;` and a syntax error, and `{{{json x}}}` there lets a value containing `</script>` break out of the script (cross-site scripting).

## Helpers

One helper per file in `views/helpers/` (flat folder, `.js` or `.mjs`). The file name is the helper name, the default export is the function. Add or edit a helper, then restart the server (it is imported once at startup).

- Signature: `(arg1, arg2, ..., options)`. Handlebars always passes its `options` object last, so variadic helpers drop it. `options.hash` holds named args (`{{fmt x style="short"}}`), `options.fn(this)` / `options.inverse(this)` render a block.
- Use a `function` (not an arrow) when you need `this`, the current context.
- Arguments that are missing at the top level arrive as `undefined`; return `""` for them instead of throwing.
- Keep helpers small and pure. Shape data (totals, labels, status classes) in the controller when it is more than formatting.

Starter set (each its own file):

```js
// views/helpers/eq.js
export default function eq(a, b) {
  return a === b;
}
```

```js
// views/helpers/gt.js
export default function gt(a, b) {
  return Number(a) > Number(b);
}
```

```js
// views/helpers/and.js   {{#if (and active (gt age 17))}}
export default function and(...args) {
  return args.slice(0, -1).every(Boolean);
}
```

```js
// views/helpers/or.js
export default function or(...args) {
  return args.slice(0, -1).some(Boolean);
}
```

```js
// views/helpers/not.js
export default function not(value) {
  return !value;
}
```

```js
// views/helpers/formatDate.js   {{formatDate createdAt}} -> "Mar 5, 2026"   {{formatDate createdAt "short"}} -> "3/5/26"
export default function formatDate(value, ...rest) {
  if (value == null || value === "") return "";
  const style = typeof rest[0] === "string" ? rest[0] : "medium"; // full | long | medium | short
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: style }).format(date);
}
```

```js
// views/helpers/ifRole.js   block helper: {{#ifRole currentUser "admin"}}...{{else}}...{{/ifRole}}
export default function ifRole(user, role, options) {
  return user?.role === role ? options.fn(this) : options.inverse(this);
}
```

```js
// views/helpers/badge.js   {{badge status}} -> <span class="...">active</span>
// Returning HTML: an object with toHTML() is printed as-is, so escape the dynamic part yourself.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const colors = { active: "bg-green-100 text-green-800", inactive: "bg-gray-100 text-gray-700" };

export default function badge(status) {
  const cls = colors[status] ?? colors.inactive;
  return { toHTML: () => `<span class="rounded px-2 py-0.5 text-xs ${cls}">${esc(status)}</span>` };
}
```

The repo already ships `currency` (`{{currency 49999}}` prints `₱49,999.00`, empty string for non-numbers), `json` and `uppercase`.

## What templates cannot do

No operators (`==`, `&&`, `+`), no variables or assignment, no string concatenation (`{{concat "a" "b"}}` is "not defined" unless you add the helper), no access to `req`/`res`/session unless you put it in `res.locals`. If a template starts to need any of that, compute it in the controller and pass the result.
