# SweetAlert2 in Xian views

Alerts, toasts, confirm dialogs and flash messages. Everything here was exercised in a real browser (SweetAlert2 11.26.25 from `https://cdn.jsdelivr.net/npm/sweetalert2@11`) together with the repo's engine and Tailwind CDN.

**Check the current state first.** When this skill was written (2026-11-12) SweetAlert2 was *not* loaded anywhere in the repo: `views/partials/head.xian` only loaded Tailwind and Bootstrap Icons. Open `head.xian` and `views/partials/swal/` before assuming; if the script tag is missing, follow "Install".

## Contents
- Install
- What `swal/init` gives you
- Recipes
- HTML versus plain text (security)
- Styling with Tailwind v4
- Toast or modal
- Testing notes

## Install

1. In `views/partials/head.xian`, after the Bootstrap Icons `<link>`, add the library and the glue partial:

```hbs
  <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
  {{>swal/init}}
```

The `.all` bundle that this URL resolves to includes SweetAlert2's own CSS, so there is no stylesheet tag. `@11` follows the newest 11.x; use `sweetalert2@11.26.25` to freeze it.

2. Copy `assets/swal/init.xian` from this skill to `views/partials/swal/init.xian` (partial name `swal/init`). The dev watcher picks up new partials, no restart needed.

Every layout that includes `{{>head}}` now has it. A page rendered with `layout: false` skips `head`, so it gets neither Swal nor the helpers.

## What `swal/init` gives you

**Flash bridge.** `app.js` already copies flash messages to `res.locals.success_msg` / `res.locals.error_msg`. `swal/init` renders them as `<meta>` tags in `<head>` and, on `DOMContentLoaded`, shows `success_msg` as a toast and `error_msg` as an error modal. Several messages are joined with ` · `. Messages are shown as plain text.

**`data-confirm` attributes** (no page script needed):

| Attribute | On | Meaning |
| --- | --- | --- |
| `data-confirm="Delete paulo?"` | `<form>` or `<a>` | ask first; the text is shown as plain text |
| `data-confirm-title`, `data-confirm-button`, `data-confirm-icon` | same element | optional title (default "Are you sure?"), confirm button label (default "Yes, continue"), icon: `warning`, `error`, `info`, `question`, `success` |
| `data-fetch-method="DELETE"` plus `data-fetch-url="/users/5"` (or `href` on an `<a>`) | `<button type="button">` or `<a>` | after confirming, call `fetch` with that method; success reloads the page (or goes to `redirect` from the JSON), failure shows the JSON `message` in an error modal |

On a `<form data-confirm>` the confirm happens on submit and the clicked button's `name`/`value` still reach the server (verified).

**`window.xian`** for your own page scripts:

```js
if (await xian.confirm("Void this sale?", { title: "Void sale", confirmText: "Void", icon: "warning" })) { /* ... */ }
xian.toast("success", "Saved");          // small, closes itself after 3.5 s
xian.error("Stock cannot go below zero"); // modal the user must dismiss
```

If the CDN script fails to load, `xian.confirm` falls back to `window.confirm` and `xian.error` to `window.alert`, so a destructive action is never allowed silently.

## Recipes

**Flash from a controller** (Post/Redirect/Get): one `req.flash` call per message, then redirect.

```js
store: async (req, res) => {
  // validate and save...
  req.flash("success_msg", `User ${name} created`);
  res.redirect("/users");
},
```

On failure: `req.flash("error_msg", "Email is required"); res.redirect("/register-page");`

**Delete through the REST route** (`RouteBuilder.resource` registers `DELETE /users/:id`; HTML forms cannot send DELETE and no method-override middleware is installed, so use the fetch attributes):

```hbs
<button type="button" class="btn" aria-label="Delete {{username}}"
        data-fetch-method="DELETE" data-fetch-url="/users/{{id}}"
        data-confirm="Delete {{username}}?" data-confirm-button="Delete">
  <i class="bi bi-trash" aria-hidden="true"></i>
</button>
```

```js
destroy: async (req, res) => {
  const deleted = await removeUser(req.params.id); // your model code
  if (!deleted) return res.status(404).json({ message: "User not found" });
  req.flash("success_msg", "User deleted");
  res.json({ ok: true }); // the page reloads and the flash shows up as a toast
},
```

**Confirm a POST form or a link:**

```hbs
<form method="POST" action="/sales/{{id}}/void" data-confirm="Void sale {{receiptNo}}?" data-confirm-button="Void sale">
  <button type="submit" class="btn">Void</button>
</form>
<a href="/logout" data-confirm="Log out?" data-confirm-icon="question" class="btn">Logout</a>
```

`{{username}}` and friends inside these attributes are HTML-escaped by Handlebars, and SweetAlert2 shows the decoded string as text, so user-supplied names are safe.

**Anything fancier** (inputs, selects, multi-step): call `Swal.fire({...})` directly and follow the safety table below.

## HTML versus plain text (security)

Several SweetAlert2 options are written to the page as HTML. Verified on 11.26.25:

| Rendered as HTML (never put user input here) | Rendered as plain text (safe) |
| --- | --- |
| `title`, `html`, `footer`, `confirmButtonText`, `cancelButtonText`, `denyButtonText`, `iconHtml` | `titleText`, `text`, `inputLabel`, `inputPlaceholder` |

So a flash message passed as `title` runs injected markup (a `<img onerror=...>` payload executed in testing). `swal/init` therefore uses `titleText` and `text` everywhere and escapes the one dynamic button label. Do the same in your own calls: names, flash text and `data-*` values go into `text` / `titleText`; if you need markup, build it from static strings or escape the dynamic parts.

## Styling with Tailwind v4

SweetAlert2's CSS is unlayered, and unlayered CSS beats Tailwind's layered utilities. Measured:

| Call | Result |
| --- | --- |
| `customClass: { popup: 'rounded-3xl', confirmButton: 'bg-emerald-600 text-white' }` | **ignored**: popup stays 5px, button stays purple |
| same with `buttonsStyling: false` | button classes apply (the `swal2-styled` class is gone) |
| `customClass: { popup: 'rounded-3xl!' }` | popup radius applies: the trailing `!` makes the utility important |

Classes added at run time are compiled by the Tailwind browser build, but buttons can flash unstyled for a frame, so `swal/init` declares `.swal-btn`, `.swal-btn-confirm` and `.swal-btn-cancel` up front in a `<style type="text/tailwindcss">` block and passes them through `customClass` with `buttonsStyling: false`. Change the look there (the brand button is red-600, the cancel button gray-200). Anything you call through `window.xian` inherits it; a bare `Swal.fire` keeps SweetAlert2's default purple unless you pass the same options.

## Toast or modal

- Toast for routine success ("Saved", "User deleted"): non-blocking, closes itself. Only one popup exists at a time, so a new toast or modal replaces the current one.
- Modal for errors the user must read and for anything destructive or irreversible (delete, void, refund). Confirm dialogs focus Cancel by default and put it on the left.
- Keep messages short and specific; say what happened to which record.

## Testing notes

- In the Claude desktop built-in browser (and any background tab) animation frames do not advance between interactions, so a closed popup can sit in the DOM with class `swal2-hide` until something forces a paint, for example a screenshot. Assert on the open popup right after triggering it (`Swal.isVisible()`, `.swal2-title`, `.swal2-html-container`), not on its disappearance.
- Resolve a dialog from a test by clicking `.swal2-confirm` or `.swal2-cancel`; the promise settles immediately.
- Expected console noise is limited to what you provoke (a failing fetch shows its HTTP status).
