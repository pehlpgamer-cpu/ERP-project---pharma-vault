# Supplier purchase returns (WF-15) design

Self-approved under the standing "develop without approval" instruction. Adds two tables,
`purchase_returns` and `purchase_return_items` (apply with `npm run db:push`). No new permissions:
it uses `purchasing.manage` (draft, submit, cancel), `purchasing.approve` (approve, reject, post) and
`purchasing.view` (read).

## Flow

`DRAFT -> PENDING_APPROVAL -> APPROVED -> POSTED`, plus `REJECTED` (from pending) and `CANCELLED`
(from draft, pending, approved). Same shape as stock counts.

- **Draft**: a supplier, a reason, and batches of the actor's branch with the quantity to send back.
  A batch must be `ACTIVE`, `QUARANTINED`, `RECALLED` or `EXPIRED` (stock being returned is often
  exactly that), with at least the quantity available, once per return, up to 100 lines. The batch's
  unit cost is snapshotted, so the value of the return is fixed.
- **Approve**: a different person from the creator. Reject and cancel need a reason (audit log).
- **Post** (`purchasing.approve`): locks the return, then inventory rows (product id order), then
  batches (id order), re-checks each batch is still returnable and still holds the quantity (409
  `return_stock` otherwise), takes the quantity off (`DEPLETED` at zero), writes a `PURCHASE_RETURN`
  movement per line, lowers on-hand, sets `POSTED`. A deadlock with a sale is retried.
- Supplier credit, replacement and payment are reconciled outside the system.

## Pages

`/purchase-returns` (list), `/purchase-returns/new`, `/purchase-returns/:id` (details, value, actions).
Sidebar link under purchasing. A return belongs to the branch that drafted it; users of other branches
get a 404 (all branches with `sales.view.all`).
