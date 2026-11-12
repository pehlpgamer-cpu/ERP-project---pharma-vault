import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { productUnits } from "./product-units.js";

// Selling price per sale unit. A row with a null branch applies to every branch; a branch row beats it.
export const productPrices = t.mysqlTable(
  "product_prices",
  {
    id: uuidPrimaryKey(),
    productUnitId: uuid("product_unit_id").notNull(),
    branchId: uuid("branch_id"),
    unitPrice: t.decimal("unit_price", { precision: 14, scale: 4 }).notNull(),
    effectiveFrom: t.datetime("effective_from").notNull(),
    effectiveTo: t.datetime("effective_to"),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [
      t
        .index("idx_product_prices_lookup")
        .on(table.productUnitId, table.branchId, table.effectiveFrom),
      t
        .foreignKey({
          name: "fk_product_prices_unit",
          columns: [table.productUnitId],
          foreignColumns: [productUnits.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_product_prices_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_product_prices_price", sql`${table.unitPrice} >= 0`),
    ];
  },
);
