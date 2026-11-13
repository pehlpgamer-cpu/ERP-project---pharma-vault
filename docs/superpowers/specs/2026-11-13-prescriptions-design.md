# Prescription verification and dispensing (WF-10) design

Self-approved under the standing "develop without approval" instruction. Tables exist
(`prescribing_physicians`, `prescriptions`, `prescription_items`, `dispensings`, `dispensing_items`,
`sale_prescriptions`); no schema change.

## Flow

1. **Record** (`prescriptions.manage`: admin, pharmacist, cashier): prescriber name and license (an
   existing physician is reused by license number; the same license under another name is refused),
   optional customer (by customer number), prescription date, optional valid-until, and items
   identified by product SKU with prescribed base-unit quantity, dosage instructions, frequency and
   duration. A number `RX-<branch>-<yyyymmdd>-<n>` is generated. Status `PENDING_VERIFICATION`.
2. **Verify or reject** (`prescriptions.verify`: admin, pharmacist): a pharmacist reviews and marks it
   `VERIFIED` (stores `verified_by`, `verified_at`) or `REJECTED` (reason in the audit log). Verifying
   an out-of-date prescription is refused. No separation of duties: the pharmacist who recorded it may
   verify it, since this is a professional review, not a financial approval.
3. **Dispense through checkout**: `POST /api/v1/sales` accepts `prescriptionId`. The prescription must
   be `VERIFIED` or `PARTIALLY_DISPENSED` and not past `valid_until`. Lines for products that need a
   prescription (not OTC, or flagged) are then allowed only if the product is on the prescription, and
   their total base quantity per product must not exceed prescribed minus dispensed. In the same
   transaction as the sale: lock the prescription and its items (after the register session, before
   inventory, so the order matches checkout), insert `dispensings` (pharmacist = the verifying
   pharmacist, since the cashier completes the sale) and `dispensing_items`, add to
   `total_dispensed_quantity`, set the prescription `PARTIALLY_DISPENSED` or `FULLY_DISPENSED`, and link
   `sale_prescriptions`. A prescription with no line using it is refused. A sale with no customer takes
   the prescription's customer; another customer is refused. OTC lines never consume a prescription.
4. **POS**: a "Prescription" box on the sales screen looks a prescription up by number
   (`GET /api/v1/prescriptions/lookup?number=`, `sales.create`); once loaded, its products can be
   added to the cart and the sale carries its id.

## Rules

- Prescriptions are chain-wide records (no branch column): any user with a prescription permission
  sees any prescription. Audit rows carry the acting branch.
- A prescription past `valid_until` shows as `EXPIRED` and cannot be verified or dispensed (computed,
  not stored). `FULLY_DISPENSED` and `REJECTED` are final.
- Everything is audited.

## Pages

`/prescriptions` (list with search by number and status), `/prescriptions/new`, `/prescriptions/:id`
(details, items with remaining quantity, linked sales, verify and reject actions).
Permissions: `prescriptions.manage`, `prescriptions.verify`; viewing needs either.
