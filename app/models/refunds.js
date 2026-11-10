import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { salesReturns } from "./sales-returns.js";

export const refunds = t.mysqlTable(
  "refunds",
  {
    id: uuidPrimaryKey(),
    salesReturnId: uuid("sales_return_id").notNull(),
    paymentMethod: t
      .mysqlEnum("payment_method", ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"])
      .notNull(),
    amount: t.decimal({ precision: 14, scale: 2 }).notNull(),
    referenceNumber: t.varchar("reference_number", { length: 150 }),
    status: t
      .mysqlEnum(["PENDING", "PROCESSED", "FAILED", "CANCELLED"])
      .notNull()
      .default("PENDING"),
    processedAt: t.datetime("processed_at"),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_refunds_return").on(table.salesReturnId),
      t
        .foreignKey({
          name: "fk_refunds_return",
          columns: [table.salesReturnId],
          foreignColumns: [salesReturns.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_refunds_amount", sql`${table.amount} > 0`),
    ];
  },
);
