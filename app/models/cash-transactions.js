import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { cashRegisterSessions } from "./cash-register-sessions.js";
import { users } from "./users.js";

export const cashTransactions = t.mysqlTable(
  "cash_transactions",
  {
    id: uuidPrimaryKey(),
    cashRegisterSessionId: uuid("cash_register_session_id").notNull(),
    transactionType: t
      .mysqlEnum("transaction_type", [
        "OPENING_CASH",
        "CASH_SALE",
        "CASH_REFUND",
        "CASH_IN",
        "CASH_OUT",
        "CLOSING_ADJUSTMENT",
      ])
      .notNull(),
    amount: t.decimal({ precision: 14, scale: 2 }).notNull(),
    referenceType: t.varchar("reference_type", { length: 100 }),
    referenceId: uuid("reference_id"),
    reason: t.text(),
    performedBy: uuid("performed_by").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_cash_transactions_session").on(table.cashRegisterSessionId, table.createdAt),
      t
        .foreignKey({
          name: "fk_cash_transactions_session",
          columns: [table.cashRegisterSessionId],
          foreignColumns: [cashRegisterSessions.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_cash_transactions_user",
          columns: [table.performedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_cash_transactions_amount", sql`${table.amount} >= 0`),
    ];
  },
);
