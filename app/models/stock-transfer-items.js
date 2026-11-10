import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { stockTransfers } from "./stock-transfers.js";
import { products } from "./products.js";
import { inventoryBatches } from "./inventory-batches.js";

export const stockTransferItems = t.mysqlTable(
  "stock_transfer_items",
  {
    id: uuidPrimaryKey(),
    stockTransferId: uuid("stock_transfer_id").notNull(),
    productId: uuid("product_id").notNull(),
    sourceInventoryBatchId: uuid("source_inventory_batch_id").notNull(),
    quantityRequested: t.decimal("quantity_requested", { precision: 14, scale: 3 }).notNull(),
    quantityShipped: t
      .decimal("quantity_shipped", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    quantityReceived: t
      .decimal("quantity_received", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    destinationInventoryBatchId: uuid("destination_inventory_batch_id"),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t
        .foreignKey({
          name: "fk_transfer_items_transfer",
          columns: [table.stockTransferId],
          foreignColumns: [stockTransfers.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfer_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfer_items_source_batch",
          columns: [table.sourceInventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfer_items_destination_batch",
          columns: [table.destinationInventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_transfer_items_qty",
        sql`${table.quantityRequested} > 0 AND ${table.quantityShipped} >= 0 AND ${table.quantityReceived} >= 0 AND ${table.quantityReceived} <= ${table.quantityShipped} AND ${table.quantityShipped} <= ${table.quantityRequested}`,
      ),
    ];
  },
);
