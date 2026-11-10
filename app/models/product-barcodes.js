import * as t from "drizzle-orm/mysql-core";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { productUnits } from "./product-units.js";

export const productBarcodes = t.mysqlTable(
  "product_barcodes",
  {
    id: uuidPrimaryKey(),
    productUnitId: uuid("product_unit_id").notNull(),
    barcode: t.varchar({ length: 100 }).notNull(),
    isPrimary: t.boolean("is_primary").notNull().default(false),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.uniqueIndex("uq_product_barcodes_barcode").on(table.barcode),
      t.index("idx_product_barcodes_unit").on(table.productUnitId),
      t
        .foreignKey({
          name: "fk_product_barcodes_unit",
          columns: [table.productUnitId],
          foreignColumns: [productUnits.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
    ];
  },
);
