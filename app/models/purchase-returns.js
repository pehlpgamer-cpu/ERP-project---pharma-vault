import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

// Stock sent back to a supplier (wrong item, damage, recall, discrepancy). Posting takes the quantity
// off the batch; supplier credit and payment are reconciled outside this schema.
export const purchaseReturns = t.mysqlTable(
  "purchase_returns",
  {
    id: uuidPrimaryKey(),
    returnNumber: t.varchar("return_number", { length: 100 }).notNull(),
    branchId: uuid("branch_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    status: t
      .mysqlEnum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "POSTED", "REJECTED", "CANCELLED"])
      .notNull()
      .default("DRAFT"),
    reason: t.text().notNull(),
    createdBy: uuid("created_by").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: t.datetime("approved_at"),
    postedAt: t.datetime("posted_at"),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_purchase_returns_number").on(table.returnNumber),
      t.index("idx_purchase_returns_branch").on(table.branchId, table.status),
      t
        .foreignKey({
          name: "fk_purchase_returns_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_returns_supplier",
          columns: [table.supplierId],
          foreignColumns: [suppliers.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_returns_creator",
          columns: [table.createdBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_returns_approver",
          columns: [table.approvedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
    ];
  },
);
