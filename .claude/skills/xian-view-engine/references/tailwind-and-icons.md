# Tailwind v4 (browser CDN) and Bootstrap Icons

How styling and icons work in Xian views, and the house style to copy. Behaviors below were measured in a real browser against the CDN builds the project loads (Tailwind browser build 4.3.5, Bootstrap Icons 1.13.1).

## Contents
- How Tailwind is loaded
- Writing your own CSS (and the cascade-layer rule)
- House style
- Tailwind v4 differences that bite
- Bootstrap Icons

## How Tailwind is loaded

`views/partials/head.xian` has `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`. That is Tailwind CSS **v4** compiled inside the browser: it reads the class names in the live DOM and keeps watching it, so classes that only appear later (SweetAlert2 popups, HTML fetched by JavaScript) are compiled on the fly.

- There is no `tailwind.config.js`, no `@import "tailwindcss"` and no build step. Do not add the v3 Play CDN (`cdn.tailwindcss.com`) or a `tailwind.config = {...}` script; theme changes go in CSS with `@theme` (below).
- Tailwind documents the browser build as a development and prototyping tool: every visitor compiles CSS on every page load and pages can flash unstyled before it finishes. If that matters in production, move to the Tailwind CLI writing `public/css/app.css` (`express.static` already serves `public/`) and swap the `<script>` in `head.xian` for a `<link>`.
- Everything arrives from jsDelivr, so pages are unstyled when the CDN is unreachable.
- A class Tailwind does not know produces no CSS and no warning. `text-xxl` (used in `main.xian` and `home.xian`) does nothing; the real sizes are `text-xl`, `text-2xl`, `text-3xl`, and so on. When a class "does nothing", check the spelling against the Tailwind docs first.

## Writing your own CSS

Put custom CSS in `<style type="text/tailwindcss">` blocks inside any layout, partial or page. The browser build merges every such block on the page into one stylesheet, so `@apply` works across them. Supported: `@apply`, `@theme`, `@layer`, `@utility`, `@custom-variant` and plain CSS.

```html
<style type="text/tailwindcss">
  @theme { --color-brand: #0a7a5b; }   /* gives bg-brand, text-brand, border-brand, ... */
  @layer components {
    .chip { @apply px-2 py-1 rounded bg-gray-200 text-gray-900; }
  }
</style>
```

Where it goes: styles shared by every page in `views/partials/css/base.xian` (already pulled into `main.xian` with `{{>css/base}}`); a component's own styles inside that component's partial; one-off page styles at the bottom of the page. Do not include the same block twice. Handlebars parses these blocks, so keep `{{` out of them.

**The layer rule.** Tailwind's utilities live in a CSS cascade layer, and CSS that is not in any layer beats layered CSS whatever the specificity. Verified consequences:

- `.btn` in `main.xian` is unlayered, so `class="btn bg-blue-500"` stays red: the utility loses. Put new component classes inside `@layer components { ... }`, where utilities can still override them (verified: `class="chip bg-blue-500"` turns blue). If you restyle `.btn`, move it into `@layer components` too.
- Third-party CSS such as SweetAlert2's is unlayered as well. Utilities passed through its `customClass` do not override its defaults unless you turn off its styling or add the important suffix. Details in `sweetalert.md`.
- The important suffix is a trailing `!`: `rounded-3xl!`.

## House style

Copy these so new screens match the existing ones:

- `main.xian`: `<body class="bg-gray-50 flex flex-col h-screen">`, a nav with the `bg-default` gradient (red-pink to peach, defined in `partials/css/base.xian`), the brand `bi bi-fire text-red-600` + "XIANFIRE", nav links as `.btn`, then `<main>`, a spacer `flex-1` and the footer partial.
- `.btn`: red-300 background, `hover:bg-black hover:text-white`, `hover:scale-105`, `duration-150`, `rounded p-2`, `cursor-pointer`.
- Content panel: `border bg-white p-3` (users page). Tables: `table-auto border bg-white` with cells `.tableCell` (`border p-1`, defined in `userTable.xian`).
- Forms (auth pages): `flex flex-col w-96 p-6 border rounded-lg shadow`; inputs `mb-2 p-2 border rounded`; submit `bg-blue-500 text-white p-2 rounded` (login) or `bg-green-500` (register); helper links `text-blue-700 mt-2 text-center`.
- Only Bootstrap **Icons** is loaded, not Bootstrap CSS. `btn-primary`, `col-md-6`, `d-flex`, `modal` and friends do not exist here. `container` works because it is a Tailwind utility.
- No JavaScript framework or jQuery is loaded. Page behavior is plain inline `<script>` (or the SweetAlert2 helpers).

## Tailwind v4 differences that bite

All measured on the 4.3.5 browser build:

| Habit from v3 / old snippets | In this build |
| --- | --- |
| `border` is a light gray line | `border` uses `currentColor`: a black line next to black text. Add `border-gray-200` or `border-gray-300` |
| `ring` is a 3px blue ring | `ring` is 1px `currentColor`. Use `ring-2 ring-blue-500` (or `ring-3`) |
| `bg-black bg-opacity-50` | `bg-opacity-*` and its siblings do nothing. Use the slash form: `bg-black/50` |
| `shadow-sm`, `rounded-sm` as the small steps | the scale moved one step: v3 `shadow-sm` is now `shadow-xs`, and `shadow` (bare) equals `shadow-sm`; v3 `rounded-sm` (2px) is now `rounded-xs`, and `rounded` (bare, 4px) equals `rounded-sm` |
| `tailwind.config.js` colors | `@theme { --color-brand: #0a7a5b; }` in a `text/tailwindcss` block |
| `bg-gradient-to-r`, `flex-shrink-0`, `flex-grow` | still work in this build, but prefer `bg-linear-to-r`, `shrink-0`, `grow` |

Numeric utilities accept any integer: `scale-106`, `border-b-1`, `w-[calc(100%-2rem)]` all work.

## Bootstrap Icons

`head.xian` loads the icon font stylesheet `bootstrap-icons@1.13.1/font/bootstrap-icons.min.css` (1.13.2 exists; bump the version only in `head.xian`). Usage: `<i class="bi bi-<name>"></i>`.

- Icons are font glyphs, so they take their size from `font-size` and their color from `color`: `<i class="bi bi-trash text-xl text-red-600"></i>`.
- Next to text, put both in `inline-flex items-center gap-2`.
- Decorative icons get `aria-hidden="true"`. An icon-only button or link needs an accessible name: `aria-label="Delete user"` (or a visually hidden `<span class="sr-only">`).
- Variants are separate names (`bi-heart` / `bi-heart-fill`); not every icon has a fill version.
- To check a name that is not listed below, search the bundled stylesheet: `curl -s https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css | grep -o "bi-[a-z0-9-]*capsule[a-z0-9-]*::before"`, or browse https://icons.getbootstrap.com. A wrong name renders nothing and logs nothing.

Names below were all checked against the 1.13.1 stylesheet (2,078 icons):

| Area | Icon names (prefix with `bi-`) |
| --- | --- |
| Navigation | `house`, `speedometer2` (dashboard), `list`, `grid`, `chevron-down`, `chevron-right`, `box-arrow-up-right` |
| People and access | `person`, `people`, `person-plus`, `person-gear`, `person-badge`, `person-circle`, `key`, `lock`, `shield-lock`, `shield-check`, `box-arrow-in-right` (log in), `box-arrow-right` (log out) |
| Pharmacy and stock | `capsule`, `capsule-pill`, `prescription2`, `prescription`, `heart-pulse`, `hospital`, `bandaid`, `eyedropper`, `thermometer`, `file-medical`, `file-earmark-medical`, `clipboard2-pulse`, `boxes`, `box-seam`, `box`, `archive`, `upc-scan`, `upc`, `qr-code`, `truck`, `arrow-left-right` (transfer), `building`, `shop`, `geo-alt` |
| Sales and cash | `cart`, `cart-check`, `receipt`, `receipt-cutoff`, `cash-stack`, `cash-coin`, `credit-card`, `currency-exchange`, `arrow-return-left` (returns), `arrow-counterclockwise`, `percent`, `tag`, `tags` |
| Reports and audit | `graph-up`, `bar-chart`, `pie-chart`, `file-earmark-text`, `file-earmark-pdf`, `download`, `printer`, `clock-history`, `journal-text`, `list-check`, `clipboard-data` |
| Actions | `plus-lg`, `pencil-square`, `pencil`, `trash`, `eye`, `search`, `funnel`, `x-lg`, `check-lg`, `three-dots-vertical`, `arrow-clockwise`, `save`, `floppy`, `sliders`, `gear` |
| Status | `check-circle`, `check-circle-fill`, `x-circle`, `exclamation-triangle`, `exclamation-circle`, `exclamation-octagon`, `info-circle`, `question-circle`, `bell`, `hourglass-split`, `clock`, `calendar3`, `calendar-event`, `patch-check`, `lightning`, `envelope`, `telephone`, `moon`, `sun`, `fire` |
