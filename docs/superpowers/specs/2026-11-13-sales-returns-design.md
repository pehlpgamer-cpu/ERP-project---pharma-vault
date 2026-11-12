# Sales returns and refunds (WF-12) design

Self-approved under the standing "develop without approval" instruction. Tables already exist
(`sales_returns`, `sales_return_items`, `refunds`); no schema change.

## Flow

`DRAFT -> PENDING_APPROVAL -> APPROVED -> PROCESSED`, with `REJECTED` (from pending) and `CANCELLED`
(from draft, pending, approved). Same shape as stock counts.

- **Draft** (`returns.create`): from a sale in the user's own branch with status `COMPLETED` or
  `PARTIALLY_REFUNDED`, sold within the last 30 business days. Lines are the sale's batch pieces
  (`sale_item_batches`): quantity in base units, a disposition (`RESTOCK`, `QUARANTINE`, `DAMAGED`,
  `DISPOSE`) and a reason for the whole return.
- **Approve / reject** (`returns.approve`): a different person from the creator.
- **Process** (`returns.approve`): picks the refund method and a reference. Then, in one transaction:
  stock effects, the refund row, the cash drawer entry, the sale status.

## Rules

- Returned quantity per batch piece, over all returns that are not rejected or cancelled, cannot exceed
  what the piece sold. The sale row is locked while a draft is written, so two drafts cannot both claim
  the same units.
- Refund per line = line total x returned base quantity / sold base quantity, rounded to cents, never
  above what is left of the line total. Returning the last units of a line refunds exactly what is left.
- `RESTOCK` adds the quantity back to the original batch, only while that batch is `ACTIVE` or
  `DEPLETED`, not past its expiry date, and never above `quantity_received`. It writes a `SALE_RETURN`
  movement and raises on-hand. The other dispositions change no stock: the schema has one quantity per
  batch, so non-sellable units live only on the return line (deferred).
- Refund method must be one the sale was paid with. A refund cannot exceed what that method paid
  (cash net of change) minus what it already refunded. Non-cash needs a reference. Cash needs the
  processor's open register session and writes a `CASH_REFUND` entry there.
- Sale becomes `REFUNDED` when processed refunds reach its total, else `PARTIALLY_REFUNDED`.
- Everything is audited. Lock order: return, sale, register session, inventories by id, batches by id;
  a deadlock is retried.

## Pages

`/returns` (list), `/sales/:id/return` (draft form), `/returns/:id` (detail and actions). The sale
page links to the form when the user may create returns. Permissions: `returns.create` (admin,
pharmacist, cashier), `returns.approve` (admin, pharmacist). Listing and detail need either.
