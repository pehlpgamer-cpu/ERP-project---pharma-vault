import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

export const purchaseOrders = t.mysqlTable(
  "purchase_orders",
  {
    id: uuidPrimaryKey(),
    poNumber: t.varchar("po_number", { length: 100 }).notNull(),
    branchId: uuid("branch_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    status: t
      .mysqlEnum([
        "DRAFT",
        "PENDING_APPROVAL",
        "APPROVED",
        "SENT",
        "PARTIALLY_RECEIVED",
        "FULLY_RECEIVED",
        "CLOSED",
        "CANCELLED",
      ])
      .notNull()
      .default("DRAFT"),
    expectedDate: t.date("expected_date"),
    notes: t.text(),
    total: t.decimal({ precision: 14, scale: 2 }).notNull().default("0"),
    createdBy: uuid("created_by").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: t.datetime("approved_at"),
    sentAt: t.datetime("sent_at"),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_purchase_orders_number").on(table.poNumber),
      t.index("idx_purchase_orders_branch_status").on(table.branchId, table.status),
      t.index("idx_purchase_orders_supplier").on(table.supplierId),
      t
        .foreignKey({
          name: "fk_purchase_orders_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_orders_supplier",
          columns: [table.supplierId],
          foreignColumns: [suppliers.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_orders_created_by",
          columns: [table.createdBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_purchase_orders_total", sql`${table.total} >= 0`),
    ];
  },
);
