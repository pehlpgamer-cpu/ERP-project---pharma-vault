import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { saleItems } from "./sale-items.js";
import { inventoryBatches } from "./inventory-batches.js";

export const saleItemBatches = t.mysqlTable(
  "sale_item_batches",
  {
    id: uuidPrimaryKey(),
    saleItemId: uuid("sale_item_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id").notNull(),
    quantity: t.decimal({ precision: 14, scale: 3 }).notNull(),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_sale_item_batches_item").on(table.saleItemId),
      t.index("idx_sale_item_batches_batch").on(table.inventoryBatchId),
      t
        .foreignKey({
          name: "fk_sale_item_batches_item",
          columns: [table.saleItemId],
          foreignColumns: [saleItems.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sale_item_batches_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_sale_item_batches_qty", sql`${table.quantity} > 0 AND ${table.unitCost} >= 0`),
    ];
  },
);
