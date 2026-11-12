# Stock overview and batch status actions (WF-04, WF-14) design

Status: approved by the user's standing instruction to proceed without approval gates (decisions below are mine and are listed for review). Sources: `pharmacy_pos_complete_user_workflow.md` sections 7 (WF-04) and 17 (WF-14); builds on the merged POS and product management.

## 1. Goal

Staff see what stock each branch can really sell, what is low or about to expire, and can take a batch out of sale (quarantine, recall) or write it off, with a movement and an audit row each time.

## 2. Scope

In: stock overview per branch (on hand, sellable, reorder flag, soon-to-expire); batch list with filters; batch actions quarantine, release, recall, write off (expired or damaged); permissions `inventory.view` and `inventory.manage`.

Out: counts and adjustments (WF-13), receiving, transfers, supplier returns, recall cases and partial-batch quarantine (the workflow marks these as extensions), purchase suggestions, scheduled expiry jobs and notifications.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | `inventory.view`: admin, pharmacist, accountant. `inventory.manage`: admin, pharmacist. Cashier has neither. | Read for finance, actions for those who judge drug quality. |
| 2 | Branch scope: a user sees their own branch; a user holding `sales.view.all` (admin, accountant) may pick any branch. | Reuses the existing all-branch capability instead of a new permission. |
| 3 | "Sellable" quantity is the sum of batches that pass `isEligibleBatch` with the business `today` and `EXPIRY_BUFFER_DAYS`; "on hand" is `inventories.quantity_on_hand`. | Workflow 7: on hand is not what may be sold. |
| 4 | Low stock: sellable below the product's reorder level. Expiring soon: ACTIVE batches with stock expiring within 30 days (a fixed horizon in this slice). Already expired batches with stock are listed separately. | Workflow 7 step 3. |
| 5 | Transitions: quarantine ACTIVE to QUARANTINED; release QUARANTINED to ACTIVE; recall ACTIVE or QUARANTINED to RECALLED (final); write off ACTIVE or QUARANTINED with stock: `quantity_available` becomes 0, status EXPIRED (reason expired) or DEPLETED (reason damaged), movement EXPIRED or DAMAGED, `inventories.quantity_on_hand` drops by the written-off quantity. Every action needs a reason of 1 to 500 characters. | Workflow 17. A recalled batch can only be written off through a later slice. |
| 6 | Lock order matches checkout: the branch's inventory row `FOR UPDATE`, then the batch row `FOR UPDATE`; READ COMMITTED transaction; audit row inside it. | Concurrent sales cannot deadlock or sell a batch being pulled. |
| 7 | Actions are POST forms with flash and redirect back to the batch list. | Same pattern as the other pages. |

## 4. Pages

| Route | Needs | Does |
| --- | --- | --- |
| `GET /inventory` | `inventory.view` | Overview table, one row per product with stock or a reorder level: product, SKU, base unit, on hand, sellable, reorder level, flags (Low, Expiring soon, Expired stock). Filters: `branchId` (all-branch users), `q`, `flag` (low, expiring, expired, any). |
| `GET /inventory/batches` | `inventory.view` | Batch list: product, batch number, expiry, available, status, received. Filters: `branchId`, `q`, `status`, `expiry` (expired, 30, 60, 90 days, any), paging. With `inventory.manage`, each row shows the actions that its status allows. |
| `POST /inventory/batches/:id/quarantine`, `/release`, `/recall`, `/write-off` | `inventory.manage` | Body `reason` (and `kind=expired|damaged` for write-off). |

A batch of another branch, or an unknown or malformed id, is a 404 for users without access to it.

## 5. Service

`app/services/inventory/stockOverview.js`: `getStockOverview({ user, branchId, q, flag, now })` and `listBatches({ user, branchId, q, status, expiry, page, perPage, now })`. `app/services/inventory/batchActions.js`: `quarantineBatch`, `releaseBatch`, `recallBatch`, `writeOffBatch` each `(user, batchId, { reason, kind }, { now, meta })` returning `{ batchId, status }`. Refusals are `HttpError` 404 (unknown or out of scope), 409 `batch_state` (transition not allowed), 422 (reason). Audit actions `BATCH_QUARANTINED`, `BATCH_RELEASED`, `BATCH_RECALLED`, `BATCH_WRITTEN_OFF` with entity type `inventory_batch`.

## 6. Testing

Real-database service tests: overview numbers against hand-built fixtures (expired, quarantined, recalled batches excluded from sellable; low and expiring flags; branch isolation); each transition and each refused transition; write-off movement and on-hand arithmetic (`chk_movements_balance`); a write-off racing a checkout for the same stock yields consistent totals; a quarantined batch is not sold by `createSale`; scope and 404 cases. Page tests: permissions, filters, action forms and flash, HTML escaping. `views:check`, `oxlint`, `oxfmt` clean.

## 7. Risks

Reserved quantity (`quantity_reserved`) is not used anywhere yet and is ignored here. A write-off of a batch that sales already drew from is allowed; history stays in `sale_item_batches`.
