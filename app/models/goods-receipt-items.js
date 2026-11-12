import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { goodsReceipts } from "./goods-receipts.js";
import { inventoryBatches } from "./inventory-batches.js";
import { products } from "./products.js";
import { purchaseOrderItems } from "./purchase-order-items.js";

// Quantities are in the purchase unit of the order line; base_quantity is what went into stock.
export const goodsReceiptItems = t.mysqlTable(
  "goods_receipt_items",
  {
    id: uuidPrimaryKey(),
    goodsReceiptId: uuid("goods_receipt_id").notNull(),
    purchaseOrderItemId: uuid("purchase_order_item_id").notNull(),
    productId: uuid("product_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id"),
    batchNumber: t.varchar("batch_number", { length: 100 }),
    manufacturingDate: t.date("manufacturing_date"),
    expirationDate: t.date("expiration_date"),
    quantityReceived: t.decimal("quantity_received", { precision: 14, scale: 3 }).notNull(),
    quantityAccepted: t.decimal("quantity_accepted", { precision: 14, scale: 3 }).notNull(),
    quantityRejected: t.decimal("quantity_rejected", { precision: 14, scale: 3 }).notNull(),
    baseQuantity: t.decimal("base_quantity", { precision: 14, scale: 3 }).notNull(),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull(),
    rejectionReason: t.varchar("rejection_reason", { length: 500 }),
    ...timestamps,
  },
  (table) => {
    return [
      t.index("idx_receipt_items_receipt").on(table.goodsReceiptId),
      t.index("idx_receipt_items_po_item").on(table.purchaseOrderItemId),
      t
        .foreignKey({
          name: "fk_receipt_items_receipt",
          columns: [table.goodsReceiptId],
          foreignColumns: [goodsReceipts.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
      t
        .foreignKey({
          name: "fk_receipt_items_po_item",
          columns: [table.purchaseOrderItemId],
          foreignColumns: [purchaseOrderItems.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_receipt_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_receipt_items_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t.check(
        "chk_receipt_items_quantities",
        sql`${table.quantityReceived} > 0 AND ${table.quantityAccepted} >= 0 AND ${table.quantityRejected} >= 0 AND ${table.quantityReceived} = ${table.quantityAccepted} + ${table.quantityRejected}`,
      ),
    ];
  },
);
