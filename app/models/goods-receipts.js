import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { purchaseOrders } from "./purchase-orders.js";
import { users } from "./users.js";

// A receipt is written already POSTED; there are no saved drafts yet, and a posted receipt is never edited.
export const goodsReceipts = t.mysqlTable(
  "goods_receipts",
  {
    id: uuidPrimaryKey(),
    receiptNumber: t.varchar("receipt_number", { length: 100 }).notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    supplierInvoiceNumber: t.varchar("supplier_invoice_number", { length: 100 }).notNull(),
    status: t.mysqlEnum(["DRAFT", "POSTED"]).notNull().default("POSTED"),
    receivedAt: t.datetime("received_at").notNull(),
    receivedBy: uuid("received_by").notNull(),
    notes: t.text(),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_goods_receipts_number").on(table.receiptNumber),
      // one supplier invoice is received once per order: this is what makes a retried post harmless
      t
        .uniqueIndex("uq_goods_receipts_invoice")
        .on(table.purchaseOrderId, table.supplierInvoiceNumber),
      t.index("idx_goods_receipts_branch").on(table.branchId, table.receivedAt),
      t
        .foreignKey({
          name: "fk_goods_receipts_order",
          columns: [table.purchaseOrderId],
          foreignColumns: [purchaseOrders.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_goods_receipts_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_goods_receipts_received_by",
          columns: [table.receivedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
    ];
  },
);
