# Interbranch stock transfers (WF-16) design

Self-approved under the standing "develop without approval" instruction. Tables exist
(`stock_transfers`, `stock_transfer_items`); no schema change.

## Flow

`DRAFT -> PENDING_APPROVAL -> APPROVED -> IN_TRANSIT -> PARTIALLY_RECEIVED -> RECEIVED`, plus
`REJECTED` (from pending) and `CANCELLED` (from draft, pending, approved).

- **Request** (destination branch, `transfers.manage`): choose a source branch and source batches with
  quantities. Draft, submit and cancel belong to the destination.
- **Approve / reject** (source branch, `transfers.approve`): admin only.
- **Dispatch** (source branch, `transfers.manage`): states the quantity actually shipped per line
  (0 to requested, at least one above 0). Locks inventory rows (product id order) then batches (id
  order), re-checks each batch is ACTIVE, unexpired and holds the shipped quantity, takes the stock off
  and writes `STOCK_TRANSFER_OUT`. Stock in transit is in neither branch.
- **Receive** (destination branch, `transfers.manage`): states quantities arriving per line, each up
  to shipped minus already received. The first receipt of a line creates a destination batch with the
  source batch's number, dates and unit cost; later receipts add to it. Writes `STOCK_TRANSFER_IN`.
  Status is `RECEIVED` once every line has received what was shipped, else `PARTIALLY_RECEIVED`.
- **Close short** (destination, reason required): `IN_TRANSIT` or `PARTIALLY_RECEIVED` to `RECEIVED`,
  recording the shortage in the audit log, so lost or damaged stock can be written off.

## Rules

- Source and destination differ. Source batches must belong to the source branch, be ACTIVE and
  unexpired, hold the requested quantity, and appear once per transfer. Up to 100 lines.
- Cancel: before dispatch only, by the destination (`transfers.manage`) or the source approver.
- Reject and cancel need a reason (kept in the audit log). Everything is audited.
- A transfer is visible to users of either branch (all branches with `sales.view.all`); a user of
  neither branch gets a 404. A user of the wrong side of a step gets a 403.
- Number: `TRF-<destination code>-<yyyymmdd>-<n>`.

## Pages

`/transfers` (list), `/transfers/new` (pick source, then lines), `/transfers/:id` (detail with the
actions available to the viewer, dispatch and receive quantity forms). Permissions: `transfers.manage`
(admin, pharmacist), `transfers.approve` (admin). Viewing needs either.
