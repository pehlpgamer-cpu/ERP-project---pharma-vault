import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { sales } from "./sales.js";
import { branches } from "./branches.js";
import { customers } from "./customers.js";
import { users } from "./users.js";

export const salesReturns = t.mysqlTable(
  "sales_returns",
  {
    id: uuidPrimaryKey(),
    saleId: uuid("sale_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    returnNumber: t.varchar("return_number", { length: 100 }).notNull(),
    customerId: uuid("customer_id"),
    returnReason: t.text("return_reason").notNull(),
    refundAmount: t.decimal("refund_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    status: t
      .mysqlEnum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "PROCESSED", "REJECTED", "CANCELLED"])
      .notNull()
      .default("DRAFT"),
    processedBy: uuid("processed_by").notNull(),
    approvedBy: uuid("approved_by"),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_sales_returns_number").on(table.returnNumber),
      t
        .foreignKey({
          name: "fk_sales_returns_sale",
          columns: [table.saleId],
          foreignColumns: [sales.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_returns_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_returns_customer",
          columns: [table.customerId],
          foreignColumns: [customers.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t
        .foreignKey({
          name: "fk_sales_returns_processor",
          columns: [table.processedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_returns_approver",
          columns: [table.approvedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t.check("chk_sales_returns_amount", sql`${table.refundAmount} >= 0`),
    ];
  },
);
