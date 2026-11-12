import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { productUnits } from "./product-units.js";
import { products } from "./products.js";
import { purchaseOrders } from "./purchase-orders.js";

// Quantities and costs are in the purchase unit; conversion_factor is the unit's factor when the
// order was written, so a later change to the product unit does not alter what was ordered.
export const purchaseOrderItems = t.mysqlTable(
  "purchase_order_items",
  {
    id: uuidPrimaryKey(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    productId: uuid("product_id").notNull(),
    productUnitId: uuid("product_unit_id").notNull(),
    conversionFactor: t.decimal("conversion_factor", { precision: 14, scale: 3 }).notNull(),
    quantityOrdered: t.decimal("quantity_ordered", { precision: 14, scale: 3 }).notNull(),
    quantityReceived: t
      .decimal("quantity_received", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull(),
    lineTotal: t.decimal("line_total", { precision: 14, scale: 2 }).notNull(),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_po_items_unit").on(table.purchaseOrderId, table.productUnitId),
      t.index("idx_po_items_product").on(table.productId),
      t
        .foreignKey({
          name: "fk_po_items_order",
          columns: [table.purchaseOrderId],
          foreignColumns: [purchaseOrders.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
      t
        .foreignKey({
          name: "fk_po_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_po_items_product_unit",
          columns: [table.productUnitId],
          foreignColumns: [productUnits.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_po_items_quantities",
        sql`${table.quantityOrdered} > 0 AND ${table.quantityReceived} >= 0 AND ${table.quantityReceived} <= ${table.quantityOrdered}`,
      ),
      t.check("chk_po_items_cost", sql`${table.unitCost} >= 0 AND ${table.lineTotal} >= 0`),
    ];
  },
);
