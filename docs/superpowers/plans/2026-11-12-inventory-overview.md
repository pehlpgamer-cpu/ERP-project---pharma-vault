# Stock Overview and Batch Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Stock overview, batch list and batch status actions (quarantine, release, recall, write off) with movements and audit.

**Architecture:** Two services (read queries, transactional actions) reuse `isEligibleBatch`, `expiryBufferDays`, `businessDate`; server-rendered pages like the product pages.

**Tech Stack:** as the merged POS: Express 4, Xian views, Drizzle rc.4 (callback mysql2), zod, Japa.

**Spec:** `docs/superpowers/specs/2026-11-12-inventory-overview-design.md`

## Global Constraints

- Same conventions as the product plan: decimal strings, block-bodied arrows, braces on `if`, `npx oxfmt` twice then `--check` on explicit paths, no `{{` in `<script>`/`<style>`, `pageTitle` and `layout: "authenticated"` on every render, `npm run views:check` exit 0, tests against `_test` database only, commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, never push.
- Permissions `inventory.view`, `inventory.manage`. Audit entity type `inventory_batch`. Movement types `EXPIRED`, `DAMAGED`.
- Lock order: inventories row (`FOR UPDATE`), then batch row (`FOR UPDATE`), as checkout.

## Review Focus

1. A write-off or status change never leaves `inventories.quantity_on_hand` and the sum of batch quantities out of step, including racing a checkout for the same stock.
2. A quarantined, recalled, written-off or expired batch is never sold, and a released batch is.
3. A user cannot see or act on another branch's batches unless they hold `sales.view.all` (view only); crafted ids are 404, never 500.
4. Every refused action (wrong state, empty or long reason, bad kind) changes nothing and writes no movement or audit row.
5. HTML in product names, batch numbers and reasons is escaped on every page and flash.

---

### Task 1: Permissions and navigation
**Files:** Modify `app/services/auth/permissions.js`, `database/seed/base.js`, `views/partials/sideNavBar.xian`, `tests/unit/permissions.spec.js`, `tests/feature/seedBase.spec.js`, `tests/feature/shell.spec.js`, `README.md` (permission rows and grant SQL).
**Produces:** `PERMISSIONS.INVENTORY_VIEW`, `INVENTORY_MANAGE`; admin all; pharmacist both; accountant `inventory.view` only; cashier neither. Sidebar link Inventory (`/inventory`, icon `boxes`) for `inventory.view`.
- [ ] Step 1: failing tests (permission names now ten, role tables, seeded permission count 10, sidebar link per role).
- [ ] Step 2: run `--files=permissions`, `seedBase`, `shell`; expect FAIL. Step 3: implement. Step 4: expect PASS. Step 5: commit `feat(inventory): inventory permissions and navigation link`.

### Task 2: Stock overview and batch list service
**Files:** Create `app/services/inventory/stockOverview.js`, `tests/feature/stockOverview.spec.js`.
**Interfaces:** `getStockOverview({ user, branchId, q, flag = "any", now = new Date() }): Promise<{ branchId, rows: { productId, sku, productName, baseUnitName, onHand, sellable, reorderLevel, low, expiringSoon, expiredStock }[] }>`; `listBatches({ user, branchId, q, status, expiry = "any", page = 1, perPage = 20, now }): Promise<{ rows: { id, productId, sku, productName, batchNumber, expirationDate: string|null, quantityAvailable, status, receivedAt }[], total }>`; `resolveBranch(user, branchId): string` (own branch; `branchId` honored only with `sales.view.all`, else `HttpError` 403; a user with no branch and no all-scope gets 403). Quantities are 3-place strings. A product row appears when it has an inventory row in the branch or batches. `expiringSoon`: ACTIVE batch with stock expiring today through today+30. `expiredStock`: batch with stock and expiry before today whose status is not DEPLETED/EXPIRED. `q` escapes LIKE wildcards.
- [ ] Step 1: failing tests (spec section 6 overview and list cases, review focus 3 scope).
- [ ] Step 2-4: run `--files=stockOverview` FAIL then implement then PASS. Step 5: commit `feat(inventory): stock overview and batch list queries`.

### Task 3: Batch actions service
**Files:** Create `app/services/inventory/batchActions.js`, `tests/feature/batchActions.spec.js`.
**Interfaces:** `quarantineBatch`, `releaseBatch`, `recallBatch`, `writeOffBatch(user, batchId, { reason, kind }, { now = new Date(), meta = {} } = {}): Promise<{ batchId, status }>` per spec decisions 5 and 6; refusals `HttpError` 404 `not_found` (unknown, malformed, other branch), 409 `batch_state`, `ValidationError` for reason and kind.
- [ ] Step 1: failing tests: each transition and refused transition; write-off movement (`quantity_change` negative, before and after, type EXPIRED/DAMAGED, unit cost = batch cost, performer) and `quantity_on_hand` drop; status EXPIRED vs DEPLETED; (review focus 1) write-off racing `createSale` for the same stock five rounds, then `quantity_on_hand` equals the batch sum; (focus 2) quarantine then `createSale` gives insufficient_stock, release then it sells, recalled and written-off never sell; (focus 4) refused actions leave tables unchanged; audit rows with old and new status and the reason.
- [ ] Step 2-4: `--files=batchActions` FAIL, implement, PASS (race test five times). Step 5: commit `feat(inventory): quarantine, release, recall and write off batches`.

### Task 4: Pages
**Files:** Create `app/http/controllers/inventoryController.js`, `app/http/requests/inventory/inventoryRequest.js` (query and action validation), `views/pages/inventory/index.xian`, `views/pages/inventory/batches.xian`, `tests/feature/inventoryPages.spec.js`; Modify `routes/web.js`.
**Interfaces:** routes per spec section 4; controller default export `{ index, batches, quarantine, release, recall, writeOff }`.
- [ ] Step 1: failing page tests: permissions (cashier 403, accountant view only and 403 on actions, pharmacist all), filters, flags rendered, action buttons by status, action flash and redirect, refused action flashes the message and changes nothing, branch scope, escaping (focus 5), 404 for crafted ids.
- [ ] Step 2-4: `--files=inventoryPages` FAIL, implement (invoke xian-view-engine guidance), PASS, `npm run views:check`. Step 5: commit `feat(inventory): stock overview and batch pages`.

### Task 5: Docs and checks
- [ ] README: pages table row, permission rows, grant SQL for existing databases (both permissions, roles by name), known limits (fixed 30-day horizon, no counts). Whole checks: oxlint and oxfmt on branch files, `views:check`, `npm test`. Commit `docs: document stock overview and batch actions`.
