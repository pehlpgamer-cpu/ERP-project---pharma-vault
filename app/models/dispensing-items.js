import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { dispensings } from "./dispensings.js";
import { prescriptionItems } from "./prescription-items.js";
import { products } from "./products.js";

export const dispensingItems = t.mysqlTable(
  "dispensing_items",
  {
    id: uuidPrimaryKey(),
    dispensingId: uuid("dispensing_id").notNull(),
    prescriptionItemId: uuid("prescription_item_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantityDispensed: t.decimal("quantity_dispensed", { precision: 14, scale: 3 }).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_dispensing_items_dispensing").on(table.dispensingId),
      t
        .foreignKey({
          name: "fk_dispensing_items_dispensing",
          columns: [table.dispensingId],
          foreignColumns: [dispensings.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_dispensing_items_prescription_item",
          columns: [table.prescriptionItemId],
          foreignColumns: [prescriptionItems.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_dispensing_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_dispensing_items_qty", sql`${table.quantityDispensed} > 0`),
    ];
  },
);
