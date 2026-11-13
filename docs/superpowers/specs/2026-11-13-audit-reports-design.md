# Audit trail viewer and stock movement ledger (WF-18) design

Self-approved under the standing "develop without approval" instruction. Read-only; no schema change.

## Audit trail (`/audit`, permission `audit.view`, admin only)

Investigation view over `audit_logs`, newest first, 50 a page. Filters: business-date range, action
(starts with), entity type (from the types present), entity id (a UUID), and a user (name or email
contains). Each row shows time, user, branch, action, entity (linked to its page when one exists:
sale, sales return, stock transfer, prescription, stock count, purchase order, product, supplier),
reason, and the old and new values as formatted JSON. Values are redacted before they leave the
service: any key naming a password, secret, token, card or pin shows `[redacted]`, at any depth.
All branches are visible; the permission is the gate. Prescription and patient details are not
copied into audit values by the services, so the viewer shows what was recorded and no more.
Not editable or deletable from the app.

## Stock movement ledger (`/reports/movements`, permission `inventory.view`)

The append-only `inventory_movements` ledger, newest first, 50 a page. Filters: movement type,
business-date range, a search (SKU, product name or batch number contains), and branch (own branch
only unless the user holds `sales.view.all`). Each row shows time, branch, product, batch, type,
signed change, before and after, unit cost, reason, who, and the source document linked when it has a
page (sale, sales return, stock transfer, stock count). Totals are not computed; this is the ledger.

## Pages and navigation

Sidebar "Audit trail" (`audit.view`) and "Movements" (`inventory.view`).
