import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { inventoryAdjustments } from "./inventory-adjustments.js";
import { inventoryBatches } from "./inventory-batches.js";

export const inventoryAdjustmentItems = t.mysqlTable(
  "inventory_adjustment_items",
  {
    id: uuidPrimaryKey(),
    inventoryAdjustmentId: uuid("inventory_adjustment_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id").notNull(),
    quantityBefore: t.decimal("quantity_before", { precision: 14, scale: 3 }).notNull(),
    countedQuantity: t.decimal("counted_quantity", { precision: 14, scale: 3 }).notNull(),
    quantityChange: t.decimal("quantity_change", { precision: 14, scale: 3 }).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t
        .foreignKey({
          name: "fk_adjustment_items_adjustment",
          columns: [table.inventoryAdjustmentId],
          foreignColumns: [inventoryAdjustments.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_adjustment_items_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_adjustment_items_qty",
        sql`${table.quantityBefore} >= 0 AND ${table.countedQuantity} >= 0 AND ${table.quantityChange} = ${table.countedQuantity} - ${table.quantityBefore}`,
      ),
    ];
  },
);
