import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { sales } from "./sales.js";
import { products } from "./products.js";
import { productUnits } from "./product-units.js";

export const saleItems = t.mysqlTable(
  "sale_items",
  {
    id: uuidPrimaryKey(),
    saleId: uuid("sale_id").notNull(),
    productId: uuid("product_id").notNull(),
    productUnitId: uuid("product_unit_id").notNull(),
    productNameSnapshot: t.varchar("product_name_snapshot", { length: 255 }).notNull(),
    genericNameSnapshot: t.varchar("generic_name_snapshot", { length: 255 }),
    quantity: t.decimal({ precision: 14, scale: 3 }).notNull(),
    baseQuantity: t.decimal("base_quantity", { precision: 14, scale: 3 }).notNull(),
    unitPrice: t.decimal("unit_price", { precision: 14, scale: 4 }).notNull(),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
    discountAmount: t
      .decimal("discount_amount", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    taxAmount: t.decimal("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    subtotal: t.decimal({ precision: 14, scale: 2 }).notNull(),
    totalAmount: t.decimal("total_amount", { precision: 14, scale: 2 }).notNull(),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_sale_items_sale").on(table.saleId),
      t.index("idx_sale_items_product").on(table.productId),
      t
        .foreignKey({
          name: "fk_sale_items_sale",
          columns: [table.saleId],
          foreignColumns: [sales.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sale_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sale_items_unit",
          columns: [table.productUnitId],
          foreignColumns: [productUnits.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check("chk_sale_items_qty", sql`${table.quantity} > 0 AND ${table.baseQuantity} > 0`),
      t.check(
        "chk_sale_items_amounts",
        sql`${table.unitPrice} >= 0 AND ${table.unitCost} >= 0 AND ${table.subtotal} >= 0 AND ${table.totalAmount} >= 0`,
      ),
    ];
  },
);
