# Suppliers, purchase orders and goods receiving (WF-05, WF-06) design

Status: approved by the user's standing instruction to proceed without approval gates (decisions below are mine and are listed for review). Source: `pharmacy_pos_complete_user_workflow.md` sections 8 and 9. Builds on the merged POS, product management and inventory overview.

## Scope

In: suppliers (list, create, edit, deactivate); purchase orders (create and edit a draft, submit, return, approve, send, cancel, close) with line and PO totals; posting a goods receipt against a sent or partly received PO, which creates batches, raises stock and writes movements; pages for all of it; audit rows; tests.

Out: requisitions, budget or authority limits, supplier invoices and payments, supplier returns of rejected stock (WF-15), receipts saved as drafts, editing a PO after it is sent, discounts and taxes per line, PDF/print output.

## Decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | New tables `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items` (models in `app/models`, applied with `db:push`). The README claim that they already exist is wrong and is fixed. | The schema had none. |
| 2 | Permissions `purchasing.view`, `purchasing.manage`, `purchasing.approve`, `inventory.receive`. admin: all; pharmacist: view, manage, receive; accountant: view. | Approval is a manager act; only admin holds it. |
| 3 | A PO belongs to the creator's own branch; everyone sees and acts only in their own branch, except `sales.view.all` users who can read all branches. | Same rule as inventory. |
| 4 | Lines are priced per purchase unit (`product_units.can_be_purchased`, active). Quantity scale 3, cost scale 4, line total scale 2 rounded half up; PO total is the sum. A line duplicating a product unit is refused. | Workflow 8.2 step 3. |
| 5 | Status moves: DRAFT→PENDING_APPROVAL (submit), PENDING_APPROVAL→DRAFT (return), PENDING_APPROVAL→APPROVED (approve), APPROVED→SENT (send), DRAFT/PENDING_APPROVAL/APPROVED→CANCELLED, FULLY_RECEIVED/PARTIALLY_RECEIVED→CLOSED. Anything else is 409 `po_state`. The creator may approve their own order. | Single-admin shops exist; the audit row records who did it. |
| 6 | Only DRAFT orders can be edited (lines replaced as a set). Supplier must be active at create, edit and send. | Controlled changes after SENT. |
| 7 | Posting a receipt takes the PO header lock, then each product's inventory row (created if missing) in product-id order, then writes batches. One receipt line per delivered batch. Receipt is posted in one step (no saved draft). | Workflow 9.1 step 8–11; drafts are out of scope. |
| 8 | A line carries received = accepted + rejected, in purchase units. Accepted must not exceed what is still open on the PO line (no over-delivery). A line with accepted > 0 needs a batch number and an expiry date after today; a line with rejected > 0 needs a reason. At least one line must have received > 0. | Rejected goods never become stock. |
| 9 | Stock added = accepted × the unit's conversion factor (base units). Batch cost = unit cost ÷ factor, scale 4. Each accepted line makes a new ACTIVE batch (never merged), one PURCHASE_RECEIVED movement and a raised on-hand total. | Workflow 9.1 step 6, 9. |
| 10 | PO line `quantity_received` counts accepted quantity in purchase units. PO becomes PARTIALLY_RECEIVED until every line is fully accepted, then FULLY_RECEIVED. | Workflow 8.2 step 9. |
| 11 | Retrying a post is safe: a receipt needs a supplier invoice number, unique per PO, so the second post is a 409 `receipt_duplicate` and creates nothing. | Workflow 9.3. |
| 12 | Numbers via `document_sequences`: `PO-<branch code>-<yyyymmdd>-<n>` and `GR-<branch code>-<yyyymmdd>-<n>` (business TZ Asia/Manila). | Same gap-free scheme as invoices. |
| 13 | Audit actions: SUPPLIER_CREATED/UPDATED, PO_CREATED/UPDATED/SUBMITTED/RETURNED/APPROVED/SENT/CANCELLED/CLOSED, GOODS_RECEIPT_POSTED. | Workflow 21. |

## Pages

| Route | Permission |
|---|---|
| `GET /suppliers`, `GET /suppliers/new`, `GET /suppliers/:id/edit`, `POST /suppliers`, `POST /suppliers/:id` | view / manage |
| `GET /purchase-orders`, `GET /purchase-orders/new`, `GET /purchase-orders/:id`, `GET /purchase-orders/:id/edit`, `POST /purchase-orders`, `POST /purchase-orders/:id` | view / manage |
| `POST /purchase-orders/:id/{submit,return,approve,send,cancel,close}` | manage; approve and return need `purchasing.approve` |
| `GET /purchase-orders/:id/receive`, `POST /purchase-orders/:id/receive` | `inventory.receive` |

## Plan (tasks, each TDD, one commit)

1. Models, permissions, seed grants, factories, README fix. Test: tables exist with checks (received = accepted + rejected, positive ordered quantity).
2. `app/services/purchasing/suppliers.js` + tests.
3. `app/services/purchasing/purchaseOrders.js` (create, update draft, transitions, get, list) + tests.
4. `app/services/purchasing/receiving.js` (`postReceipt`) + tests incl. partial, rejected, over-delivery, duplicate, rollback, race with a sale.
5. Requests, controllers, routes, views, nav, README + page tests.

## Review focus

1. Two clerks post receipts for the same PO at once: stock and received quantities add up once each. 2. Retried post creates nothing twice. 3. Over-delivery and expired batches never reach stock. 4. A conversion factor other than 1 (box of 100). 5. Another branch's PO is a 404 for actions.
