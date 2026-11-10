import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { sales } from "./sales.js";

export const salePayments = t.mysqlTable(
  "sale_payments",
  {
    id: uuidPrimaryKey(),
    saleId: uuid("sale_id").notNull(),
    paymentMethod: t
      .mysqlEnum("payment_method", ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"])
      .notNull(),
    amount: t.decimal({ precision: 14, scale: 2 }).notNull(),
    referenceNumber: t.varchar("reference_number", { length: 150 }),
    paymentStatus: t
      .mysqlEnum("payment_status", ["PENDING", "AUTHORIZED", "PAID", "FAILED", "REFUNDED"])
      .notNull()
      .default("PENDING"),
    paidAt: t.datetime("paid_at"),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_sale_payments_sale").on(table.saleId),
      t
        .foreignKey({
          name: "fk_sale_payments_sale",
          columns: [table.saleId],
          foreignColumns: [sales.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_sale_payments_amount", sql`${table.amount} > 0`),
    ];
  },
);
