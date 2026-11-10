import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { productCategories } from "./product-categories.js";
import { manufacturers } from "./manufacturers.js";

export const products = t.mysqlTable(
  "products",
  {
    id: uuidPrimaryKey(),
    categoryId: uuid("category_id"),
    manufacturerId: uuid("manufacturer_id"),
    sku: t.varchar({ length: 100 }).notNull(),
    genericName: t.varchar("generic_name", { length: 255 }).notNull(),
    brandName: t.varchar("brand_name", { length: 255 }),
    productName: t.varchar("product_name", { length: 255 }).notNull(),
    strength: t.varchar({ length: 100 }),
    dosageForm: t.varchar("dosage_form", { length: 100 }),
    description: t.text(),
    prescriptionClassification: t
      .mysqlEnum("prescription_classification", ["OTC", "PRESCRIPTION", "CONTROLLED", "OTHER"])
      .notNull()
      .default("OTC"),
    requiresPrescription: t.boolean("requires_prescription").notNull().default(false),
    reorderLevel: t.decimal("reorder_level", { precision: 14, scale: 3 }).notNull().default("0"),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_products_sku").on(table.sku),
      t.index("idx_products_name").on(table.productName),
      t.index("idx_products_generic_name").on(table.genericName),
      t.index("idx_products_category").on(table.categoryId),
      t
        .foreignKey({
          name: "fk_products_category",
          columns: [table.categoryId],
          foreignColumns: [productCategories.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t
        .foreignKey({
          name: "fk_products_manufacturer",
          columns: [table.manufacturerId],
          foreignColumns: [manufacturers.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t.check("chk_products_reorder", sql`${table.reorderLevel} >= 0`),
    ];
  },
);
