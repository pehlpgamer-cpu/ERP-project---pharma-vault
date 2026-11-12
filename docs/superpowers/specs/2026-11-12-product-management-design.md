# Product management (WF-03) design

Status: draft for review. Source workflow: `pharmacy_pos_complete_user_workflow.md` section 6 (WF-03). Builds on the merged POS (spec `2026-11-12-pharmacy-pos-sales-api-design.md`).

## 1. Goal

Staff can create, edit, deactivate and reactivate medicines and supplies from the browser, so the POS can sell products that were not in the seed. A new product is sellable once it has a unit with a price and stock exists (stock arrives in a later slice).

## 2. Scope

In: product list with search and filters; create form; edit form; activate and deactivate; units with conversion factors; barcodes; one global selling price per sellable unit; audit rows; new permission `products.manage`.

Out: category, manufacturer and unit management (forms pick existing rows); stock overview, counts, adjustments, batch status actions; receiving; branch-specific prices; JSON API for products; CSV import; product images.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | New permission `products.manage`, granted to admin and pharmacist. No new role. | The workflow names an Inventory Clerk, but a role is a separate decision; the pharmacist already reviews drug class. |
| 2 | Once a product has batches or sale items, its existing units keep unit, factor and base flag. Everything else stays editable, and units can be added. | Workflow step 9; protects stock maths and old receipts. |
| 3 | Forms pick categories, manufacturers and units from existing rows. | Keeps the slice small. |
| 4 | The form sets a global price per sellable unit. Changing a price closes the current global row (`effective_to = now`) and inserts a new row effective now. | A product with no price cannot be sold (`no_price`); history stays intact and `pickPrice` needs no change. |
| 5 | A product is created with no stock. | Workflow 6.2. Stock comes only from goods receipt. |
| 6 | Updates and status changes are plain POST routes with flash and redirect. | Browsers send only GET and POST from forms. |

## 4. Pages and routes

All behind `requireAuth` and `requirePermission("products.manage")`.

| Route | Does |
| --- | --- |
| `GET /products` | List: 20 per page. Filters `q` (SKU, product, generic, brand; `%`, `_`, `\` match literally), `status` (active, inactive, any), `categoryId`. Columns: SKU, name, generic, class, base unit, active, reorder level. |
| `GET /products/create` | Empty form with one base unit row. |
| `POST /products` | Create. Success flashes and redirects to `/products`; failure re-renders the form with field errors and the typed values. |
| `GET /products/:id/edit` | Form filled from the product. Shows a notice and read-only unit fields when the edit lock applies. |
| `POST /products/:id` | Update. Same success and failure behavior. |
| `POST /products/:id/status` | Body `active=1` or `active=0`. Flash and redirect to the list. |

An unknown or malformed id is a 404 page. The sidebar gets a Products link for users with `products.manage`.

## 5. Form fields and validation

Product: `sku` (1 to 100, unique), `productName` (1 to 255), `genericName` (1 to 255), `brandName` (optional, 255), `strength` (optional, 100), `dosageForm` (optional, 100), `categoryId` and `manufacturerId` (optional, must exist), `description` (optional, 2000), `prescriptionClassification` (OTC, PRESCRIPTION, CONTROLLED, OTHER), `requiresPrescription`, `reorderLevel` (zero or more, 3 decimals, base units), `isActive`.

Rules: PRESCRIPTION and CONTROLLED force `requiresPrescription` on. OTC with the flag on is allowed (checkout blocks it either way).

Units (1 to 10 rows): `unitId` (existing, no repeats), `conversionFactor` (more than zero, 3 decimals, at most 11 whole digits), `isBaseUnit`, `canBeSold`, `isActive`, `barcodes` (0 to 5, 1 to 100 characters, unique across all products, no repeats), `price` (required when `canBeSold`; zero or more, 4 decimals). Exactly one base unit and its factor is 1.

All numbers arrive as strings and stay exact decimal strings. Errors are 422 with `{ path, message }` details; the form shows them beside the field. A duplicate SKU or barcode found by the database (race) is reported as the same field error, never a 500.

## 6. Edit lock

`hasHistory(productId)` is true when any `inventory_batches` or `sale_items` row references the product. When true:
- existing product units cannot change `unitId`, `conversionFactor` or `isBaseUnit`; such a change is a 422 on that row;
- units cannot be removed (they can be set inactive);
- new units can be added, but not as the base unit.

Without history, units may be changed freely; removed rows are deleted only when no price or barcode of another table references them (otherwise 422 asking to deactivate).

## 7. Service

`app/services/catalog/productAdmin.js` exports `listProducts(filters)`, `getProductForEdit(id)`, `createProduct(user, input, { now })`, `updateProduct(user, id, input, { now })`, `setProductActive(user, id, active, { now })`. Each write is one `READ COMMITTED` transaction that locks the product row `FOR UPDATE` on update, writes product, units, barcodes and prices, and appends the audit row (`PRODUCT_CREATED`, `PRODUCT_UPDATED`, `PRODUCT_ACTIVATED`, `PRODUCT_DEACTIVATED`) with old and new values. Prices go through the rule in decision 4. Request validation lives in `app/http/requests/product/productRequest.js` (zod, like the other requests).

## 8. Permission migration

`products.manage` joins `PERMISSIONS`, `ROLE_PERMISSIONS` (admin and pharmacist) and the seed. A database seeded before this change needs a re-seed, or one `INSERT` of the permission plus its `role_permissions` rows; the README says so.

## 9. Testing

- Unit: request validation (one base unit, factor rules, barcode and unit repeats, Rx forcing, decimal strings).
- Service, real database: create writes product, units, barcodes, prices and audit in one transaction; failure leaves nothing; duplicate SKU and barcode (including two concurrent creates) give field errors; price change closes the old row and the new product sells through `createSale`; edit lock cases; deactivated product leaves product lookup and checkout.
- Pages: list filters and wildcard search; create and edit round trip; field errors keep typed values; lock notice; 403 for cashier and accountant; 401 redirect; HTML in names is escaped (review focus from the POS spec).
- `npm run views:check` exits 0; `oxlint` and `oxfmt --check` pass on new files.
- Browser pass: create a product, price it, find it in the POS, sell it.

## 10. Risks

| Risk | Fallback |
| --- | --- |
| A product with units but no stock confuses cashiers (it appears in search with 0 available). | The POS already disables adding it; stock slice follows. |
| Dynamic unit rows need a client script. | The script only clones and removes DOM rows; the server validates everything and the form works with one row without it. |
| Re-seed needed for the permission. | Documented; one SQL grant given in the README. |
