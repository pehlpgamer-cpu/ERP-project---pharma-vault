import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { products } from "./products.js";
import { units } from "./units.js";

export const productUnits = t.mysqlTable(
  "product_units",
  {
    id: uuidPrimaryKey(),
    productId: uuid("product_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    // Number of base units contained in this unit. Decimal values remain strings.
    conversionFactor: t.decimal("conversion_factor", { precision: 14, scale: 3 }).notNull(),
    isBaseUnit: t.boolean("is_base_unit").notNull().default(false),
    canBePurchased: t.boolean("can_be_purchased").notNull().default(true),
    canBeSold: t.boolean("can_be_sold").notNull().default(true),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_product_unit").on(table.productId, table.unitId),
      t.index("idx_product_units_product").on(table.productId),
      t
        .foreignKey({
          name: "fk_product_units_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_product_units_unit",
          columns: [table.unitId],
          foreignColumns: [units.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_product_units_factor", sql`${table.conversionFactor} > 0`),
    ];
  },
);
