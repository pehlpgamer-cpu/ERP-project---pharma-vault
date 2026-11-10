import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { salesReturns } from "./sales-returns.js";
import { saleItems } from "./sale-items.js";
import { inventoryBatches } from "./inventory-batches.js";

export const salesReturnItems = t.mysqlTable(
  "sales_return_items",
  {
    id: uuidPrimaryKey(),
    salesReturnId: uuid("sales_return_id").notNull(),
    saleItemId: uuid("sale_item_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id"),
    quantity: t.decimal({ precision: 14, scale: 3 }).notNull(),
    unitPrice: t.decimal("unit_price", { precision: 14, scale: 4 }).notNull(),
    refundAmount: t.decimal("refund_amount", { precision: 14, scale: 2 }).notNull(),
    disposition: t.mysqlEnum(["RESTOCK", "QUARANTINE", "DAMAGED", "DISPOSE"]).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t
        .foreignKey({
          name: "fk_sales_return_items_return",
          columns: [table.salesReturnId],
          foreignColumns: [salesReturns.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_return_items_sale_item",
          columns: [table.saleItemId],
          foreignColumns: [saleItems.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sales_return_items_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_sales_return_items_qty",
        sql`${table.quantity} > 0 AND ${table.unitPrice} >= 0 AND ${table.refundAmount} >= 0`,
      ),
    ];
  },
);
