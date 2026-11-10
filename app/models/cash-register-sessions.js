import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { cashRegisters } from "./cash-registers.js";
import { users } from "./users.js";

export const cashRegisterSessions = t.mysqlTable(
  "cash_register_sessions",
  {
    id: uuidPrimaryKey(),
    cashRegisterId: uuid("cash_register_id").notNull(),
    cashierId: uuid("cashier_id").notNull(),
    openingCash: t.decimal("opening_cash", { precision: 14, scale: 2 }).notNull().default("0"),
    expectedCash: t.decimal("expected_cash", { precision: 14, scale: 2 }).notNull().default("0"),
    actualCash: t.decimal("actual_cash", { precision: 14, scale: 2 }),
    variance: t.decimal({ precision: 14, scale: 2 }),
    openedAt: t.datetime("opened_at").notNull(),
    closedAt: t.datetime("closed_at"),
    status: t.mysqlEnum(["OPEN", "CLOSED", "RECONCILIATION_REQUIRED"]).notNull().default("OPEN"),
    ...timestamps,
  },
  (table) => {
    return [
      t.index("idx_register_sessions_register_status").on(table.cashRegisterId, table.status),
      t.index("idx_register_sessions_cashier").on(table.cashierId, table.openedAt),
      t
        .foreignKey({
          name: "fk_sessions_register",
          columns: [table.cashRegisterId],
          foreignColumns: [cashRegisters.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sessions_cashier",
          columns: [table.cashierId],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_sessions_opening_cash", sql`${table.openingCash} >= 0`),
    ];
  },
);
