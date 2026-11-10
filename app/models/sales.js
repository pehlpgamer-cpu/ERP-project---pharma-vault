import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { customers } from "./customers.js";
import { users } from "./users.js";
import { cashRegisterSessions } from "./cash-register-sessions.js";

export const sales = t.mysqlTable(
  "sales",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id").notNull(),
    customerId: uuid("customer_id"),
    cashierId: uuid("cashier_id").notNull(),
    cashRegisterSessionId: uuid("cash_register_session_id").notNull(),
    invoiceNumber: t.varchar("invoice_number", { length: 100 }).notNull(),
    transactionDate: t.datetime("transaction_date").notNull(),
    subtotal: t.decimal({ precision: 14, scale: 2 }).notNull().default("0"),
    discountAmount: t
      .decimal("discount_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    taxAmount: t.decimal("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    totalAmount: t.decimal("total_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    amountPaid: t.decimal("amount_paid", { precision: 14, scale: 2 }).notNull().default("0"),
    changeAmount: t.decimal("change_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    status: t
      .mysqlEnum(["PENDING", "COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"])
      .notNull()
      .default("PENDING"),
    idempotencyKey: t.varchar("idempotency_key", { length: 100 }),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_sales_invoice").on(table.invoiceNumber),
      t.uniqueIndex("uq_sales_idempotency").on(table.idempotencyKey),
      t.index("idx_sales_branch_date").on(table.branchId, table.transactionDate),
      t.index("idx_sales_customer").on(table.customerId),
      t
        .foreignKey({
          name: "fk_sales_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_customer",
          columns: [table.customerId],
          foreignColumns: [customers.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t
        .foreignKey({
          name: "fk_sales_cashier",
          columns: [table.cashierId],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_session",
          columns: [table.cashRegisterSessionId],
          foreignColumns: [cashRegisterSessions.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_sales_amounts",
        sql`${table.subtotal} >= 0 AND ${table.discountAmount} >= 0 AND ${table.taxAmount} >= 0 AND ${table.totalAmount} >= 0 AND ${table.amountPaid} >= 0 AND ${table.changeAmount} >= 0`,
      ),
    ];
  },
);
