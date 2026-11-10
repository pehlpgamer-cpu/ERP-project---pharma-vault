import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { products } from "./products.js";

export const inventories = t.mysqlTable(
  "inventories",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantityOnHand: t
      .decimal("quantity_on_hand", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    quantityReserved: t
      .decimal("quantity_reserved", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_inventory_branch_product").on(table.branchId, table.productId),
      t
        .foreignKey({
          name: "fk_inventories_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_inventories_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_inventory_quantities",
        sql`${table.quantityOnHand} >= 0 AND ${table.quantityReserved} >= 0 AND ${table.quantityReserved} <= ${table.quantityOnHand}`,
      ),
    ];
  },
);
