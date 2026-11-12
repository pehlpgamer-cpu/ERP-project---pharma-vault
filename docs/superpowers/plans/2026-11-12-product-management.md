# Product Management (WF-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff with `products.manage` create, edit, deactivate and reactivate products, units, barcodes and prices from the browser.

**Architecture:** One service (`productAdmin.js`) owns every write in a `READ COMMITTED` transaction with an audit row; a zod request validates the form; server-rendered Xian pages follow the register page pattern (flash and redirect, field errors re-render the form). A small static script only adds and removes unit rows.

**Tech Stack:** Express 4, Xian views, Drizzle 1.0.0-rc.4 (callback mysql2 pool in `database/client.js`), zod, Japa, oxlint/oxfmt. Same conventions as the merged POS (decimal strings, `HttpError`/`ValidationError`, `asyncHandler`, test helpers in `tests/helpers`).

**Spec:** `docs/superpowers/specs/2026-11-12-product-management-design.md`

## Global Constraints

- Node 24 ESM. Money and quantities are decimal strings (`app/services/support/decimal.js`); never floats.
- Arrow functions use block bodies with `return`; `if` always has braces (oxlint rules). Run `npx oxfmt` twice before `--check`, on explicit paths only.
- Views: no `{{` inside `<script>` or `<style>` in `.xian`; static scripts live in `public/js` and take server data from `data-*` attributes. Every `res.render` passes `pageTitle` and `layout: "authenticated"`. `npm run views:check` must exit 0.
- Tests run only against a database whose name ends `_test` (`npm test`; filter with `--files=<end of file name>`). Needs a MySQL 8.4 and `.env.test` (see README).
- Commit after each task, conventional messages, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push.
- Permission name: `products.manage`. Audit actions: `PRODUCT_CREATED`, `PRODUCT_UPDATED`, `PRODUCT_ACTIVATED`, `PRODUCT_DEACTIVATED`, entity type `product`.

## Review Focus

1. A duplicate SKU or barcode, including two creates racing, is a field error (422 form), never a 500 and never two rows.
2. A product that has batches or sales can never have an existing unit's factor, unit or base flag changed, by any request shape.
3. Product, brand and unit names containing HTML show escaped in the list, the form and flash messages.
4. A failed create or update leaves no product, unit, barcode, price or audit row behind.
5. A price edit never rewrites history: the old row gets `effective_to`, a new row is inserted, and a sale made before the edit keeps its price.

---

### Task 1: Permission, seed and navigation

**Files:**
- Modify: `app/services/auth/permissions.js`, `database/seed/base.js`, `views/partials/sideNavBar.xian`, `tests/unit/permissions.spec.js`, `tests/feature/seedBase.spec.js` (only where a count or list of permissions is asserted)

**Interfaces:**
- Produces: `PERMISSIONS.PRODUCTS_MANAGE === "products.manage"`; `ROLE_PERMISSIONS.admin` (all) and `.pharmacist` include it; cashier and accountant do not.

- [ ] **Step 1: Write the failing tests:** permissions spec asserts the constant, admin and pharmacist hold it, cashier and accountant do not; seed spec asserts the seeded `permissions` table has `products.manage` linked to admin and pharmacist roles; nav test (add to `tests/feature/shell.spec.js`) shows a Products link for pharmacist and none for cashier.
- [ ] **Step 2: Run `npm test -- --files=permissions`, `--files=seedBase`, `--files=shell`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the constant, the role grants, a `PERMISSION_DESCRIPTIONS` entry ("Create and edit products"), and `{{#if (can "products.manage")}}` link to `/products` (icon `capsule`) in the sidebar.
- [ ] **Step 4: Run the same commands.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app database views tests`; `feat(products): products.manage permission and navigation link`.

---

### Task 2: Product request validator

**Files:**
- Create: `app/http/requests/product/productRequest.js`, `tests/unit/productRequest.spec.js`

**Interfaces:**
- Consumes: `parse` from `app/http/requests/validate.js`, `toScale`, `cmp`, `isDecimal` from `decimal.js`.
- Produces: `productRequest(body): ProductInput` where `ProductInput = { sku, productName, genericName, brandName: string|null, strength: string|null, dosageForm: string|null, categoryId: string|null, manufacturerId: string|null, description: string|null, prescriptionClassification, requiresPrescription: boolean, reorderLevel: string (3 places), isActive: boolean, units: { id: string|null, unitId, conversionFactor: string (3 places), isBaseUnit: boolean, canBeSold: boolean, isActive: boolean, barcodes: string[], price: string|null (4 places) }[] }`. Accepts form-encoded input as Express parses it: `units` is an array of objects or an object keyed by index (`units[0][unitId]`); checkboxes arrive as `"on"`/`"1"` or are absent; empty strings mean null for optional fields; `barcodes` is one text value split on commas and whitespace. Throws `ValidationError` with `details[].path` like `units.1.conversionFactor`.

- [ ] **Step 1: Write the failing tests** (spec sections 5 and 6 values):

```js
valid minimal body (one base unit "Tablet" factor 1, price "3.5") → normalized: reorderLevel "0.000", price "3.5000", flags booleans, barcodes []
units keyed by index object {0:{...},1:{...}} equals the array form
no base unit, two base units, base unit with factor 2 → 422 on units
factor "0", "-1", "abc", "1.2345", 12 whole digits → 422 at units.N.conversionFactor
same unitId twice → 422; more than 10 units → 422; zero units → 422
canBeSold with empty price → 422 at units.N.price; price "-1", "1.00001", "1e3" → 422; price ignored (null) when not canBeSold
barcodes "A1, B2  C3" → ["A1","B2","C3"]; repeat inside one product → 422; more than 5 → 422; over 100 chars → 422
classification PRESCRIPTION or CONTROLLED → requiresPrescription true even when absent; OTC keeps what was sent
sku empty or over 100, productName empty, categoryId not a uuid → 422; unknown classification → 422
reorderLevel "abc" or "-1" → 422; "" → "0.000"
```

- [ ] **Step 2: Run `npm test -- --files=productRequest`.** Expected: FAIL.
- [ ] **Step 3: Implement** with zod and a pre-step that normalizes form shapes (array-or-keyed-object units, checkbox values, comma/space barcode text) before the schema.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add app tests`; `feat(products): product form validation`.

---

### Task 3: Product service

**Files:**
- Create: `app/services/catalog/productAdmin.js`, `tests/feature/productAdmin.spec.js`
- Modify: `tests/helpers/factories.js` (add `makeCategory`, `makeManufacturer` if missing)

**Interfaces:**
- Consumes: Task 2 `ProductInput`, `recordAudit(tx, entry)`, `isDuplicateEntry`, `isUuid`, `HttpError`, `ValidationError`, models `products productUnits productBarcodes productPrices units inventoryBatches saleItems`.
- Produces:
  - `listProducts({ q, status = "active", categoryId, page = 1, perPage = 20 }): Promise<{ rows: { id, sku, productName, genericName, prescriptionClassification, isActive, reorderLevel, baseUnitName, categoryName }[], total }>`; `q` escapes `%`, `_`, `\`.
  - `getProductForEdit(id): Promise<{ product: ProductInput-shaped object with id, units (each with id, name, price current global, barcodes), hasHistory: boolean } | null>` (null for unknown or malformed id).
  - `createProduct(user, input, { now = new Date(), meta = {} } = {}): Promise<{ id }>`
  - `updateProduct(user, id, input, { now, meta }): Promise<{ id }>` (404 `HttpError` when missing)
  - `setProductActive(user, id, active, { now, meta }): Promise<{ id, changed }>`
  - Field errors are `ValidationError` with paths `sku`, `units.N.barcodes`, `units.N.conversionFactor` etc.; unknown `categoryId`/`manufacturerId`/`unitId` → `ValidationError`.
- Behavior: create/update/status each in one `READ COMMITTED` transaction; update locks the product row `FOR UPDATE`; unit rows matched by `id`; global price rule: unchanged price does nothing, changed price sets `effectiveTo = now` on the open global row (`branch_id IS NULL`, `effective_to IS NULL`) and inserts `{ branchId: null, effectiveFrom: now }`; a unit set to not sellable keeps its price rows; duplicate key errors (`uq_products_sku`, `uq_product_barcodes_barcode`) map to `ValidationError` on `sku` / `units.N.barcodes`; edit lock per spec section 6; removing a unit with history is 422 "deactivate it instead"; audit rows carry old and new values (no secrets exist here).

- [ ] **Step 1: Write the failing tests** (real database, `resetDatabase` per test):

```js
create: product + units + barcodes + global prices + one PRODUCT_CREATED audit row; product starts with no inventory row
create then createSale of that product (factories: branch, cashier, session, stock via makeStock) succeeds at the typed price; a unit without price fails createSale with no_price
(Review Focus 1) duplicate sku → ValidationError path "sku", nothing written; duplicate barcode (also one used by another product) → path "units.0.barcodes"; Promise.all of two creates with the same sku → one fulfills, one ValidationError, one product row
(Review Focus 4) a failure after the product insert (barcode clash on the second unit) leaves zero rows in products, product_units, product_barcodes, product_prices, audit_logs
unknown categoryId / manufacturerId / unitId → ValidationError
update without history: change name, class, reorder, factor of a unit, drop a unit, add a unit, move a barcode between units → persisted; one PRODUCT_UPDATED audit row with old and new values
(Review Focus 2) with history (makeStock batch, then separately a makeSaleIn sale): changing factor, unit or base flag of an existing unit → ValidationError path units.N.*; removing a unit → ValidationError; adding a non-base unit works; a second base unit is rejected; name, class, barcodes, flags, price still editable
(Review Focus 5) price change: old row effectiveTo === now, new row effectiveFrom === now; unchanged price writes no row; loadEffectivePrices at now-1s gives the old price and at now the new one; an existing sale keeps its unit_price
setProductActive: false hides the product from searchProducts and createSale rejects it (validation_failed); true restores it; repeating returns changed false and writes no second audit row
listProducts: q matches sku, name, generic, brand case-insensitively; q "%" and "_" match nothing when no name has them and match literally when one does; status filter; category filter; pagination total; rows ordered by productName
getProductForEdit: unknown and malformed ids (incl. "é") → null; hasHistory true after a batch exists
```

- [ ] **Step 2: Run `npm test -- --files=productAdmin`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Mutation-check the two concurrency/lock tests (remove the `FOR UPDATE`, and the history check) once, and restore.
- [ ] **Step 4: Run it.** Expected: PASS (run the concurrent create test five times).
- [ ] **Step 5: Commit.** `git add app tests`; `feat(products): product service with unit, barcode and price rules`.

---

### Task 4: Pages, routes and form script

**Files:**
- Create: `app/http/controllers/productController.js`, `views/pages/products/index.xian`, `views/pages/products/form.xian`, `public/js/product-form.js`, `tests/feature/productPages.spec.js`
- Modify: `routes/web.js`

**Interfaces:**
- Consumes: Task 3 service, Task 2 `productRequest`, `requirePermission(PERMISSIONS.PRODUCTS_MANAGE)`.
- Produces: default export `{ index, create, store, edit, update, status }`; routes per spec section 4. `form.xian` needs `product` (values), `errors` (map path → message, empty object when none), `categories`, `manufacturers`, `unitOptions`, `hasHistory`, `isNew`, `action`; unit rows render server-side and `data-*` attributes carry a row template for the script (`data-unit-options` as JSON via the `json` helper).

- [ ] **Step 1: Write the failing tests** (HTTP with `loginAs`; pharmacist and admin allowed):

```js
cashier and accountant → 403 on every route; signed out → 302 /login-page; sidebar link visible to pharmacist
list: filters (q, status, categoryId), pagination links keep filters, empty state, columns, wildcard q "%" literal
(Review Focus 3) product name, brand, generic name and a unit's barcode set to <img src=x onerror=alert(1)> render as &lt;img on list and edit form, and in the flash after save
create happy path: POST → 302 /products, flash "Product created", product sellable in /api/v1/products?q= for a cashier
create with errors (duplicate sku, no base unit, bad factor): 422 re-render keeps typed values, shows the message beside the field; nothing written
edit page for a product with history shows the lock notice and read-only factor/base fields; a crafted POST that changes them is refused with the field error
update happy path; status deactivate then activate; unknown or malformed id on edit/update/status → 404 page
public/js/product-form.js is served as JavaScript, has no "innerHTML" and no "{{"
```

- [ ] **Step 2: Run `npm test -- --files=productPages`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Invoke the `xian-view-engine` skill first. Form uses the shared `.field` class, works with one unit row without JavaScript, script clones a `<template>` row and renumbers `units[N][...]` names, remove button per row (hidden when only one remains). Re-render on error passes the submitted values back (strict mode: every printed variable present).
- [ ] **Step 4: Run it and `npm run views:check`.** Expected: PASS; exit 0.
- [ ] **Step 5: Browser check** with the dev server and a seeded database: sign in as `pharmacist@pharmavault.test`, create "Test Syrup" with a base and a larger unit, a barcode and prices; sign in as the MAIN cashier, find it in the POS (shows 0 stock, add disabled); edit the price; deactivate it. Expect no console errors at desktop and 375 px width. Fix anything found.
- [ ] **Step 6: Commit.** `git add app views public routes tests`; `feat(products): product list and create/edit pages`.

---

### Task 5: Docs and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README:** pages table row for `/products`; permission table row for `products.manage`; a note that a database seeded earlier needs a re-seed or this SQL (give the exact `INSERT` into `permissions` and `role_permissions` for the admin and pharmacist role ids, written with subselects by name).
- [ ] **Step 2: Whole checks:** `npx oxlint` and `npx oxfmt --check` on every file added or changed on the branch, `npm run views:check`, `npm test`. Expected: all clean and green.
- [ ] **Step 3: Commit.** `git add README.md`; `docs: document product management and the products.manage grant`.
