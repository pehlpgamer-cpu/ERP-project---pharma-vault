import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { users } from "./users.js";

export const inventoryAdjustments = t.mysqlTable(
  "inventory_adjustments",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id").notNull(),
    adjustmentNumber: t.varchar("adjustment_number", { length: 100 }).notNull(),
    status: t
      .mysqlEnum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "POSTED", "CANCELLED"])
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
      t.uniqueIndex("uq_adjustments_number").on(table.adjustmentNumber),
      t
        .foreignKey({
          name: "fk_adjustments_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_adjustments_creator",
          columns: [table.createdBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_adjustments_approver",
          columns: [table.approvedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
    ];
  },
);
