import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { purchaseReturns } from "./purchase-returns.js";
import { inventoryBatches } from "./inventory-batches.js";

export const purchaseReturnItems = t.mysqlTable(
  "purchase_return_items",
  {
    id: uuidPrimaryKey(),
    purchaseReturnId: uuid("purchase_return_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id").notNull(),
    quantity: t.decimal({ precision: 14, scale: 3 }).notNull(),
    // the batch's unit cost when the return was drafted, so the value sent back is fixed
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_purchase_return_items_return").on(table.purchaseReturnId),
      t
        .foreignKey({
          name: "fk_purchase_return_items_return",
          columns: [table.purchaseReturnId],
          foreignColumns: [purchaseReturns.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_purchase_return_items_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_purchase_return_items_qty",
        sql`${table.quantity} > 0 AND ${table.unitCost} >= 0`,
      ),
    ];
  },
);
