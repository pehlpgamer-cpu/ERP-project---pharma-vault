import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { prescriptions } from "./prescriptions.js";
import { products } from "./products.js";

export const prescriptionItems = t.mysqlTable(
  "prescription_items",
  {
    id: uuidPrimaryKey(),
    prescriptionId: uuid("prescription_id").notNull(),
    productId: uuid("product_id").notNull(),
    prescribedQuantity: t.decimal("prescribed_quantity", { precision: 14, scale: 3 }).notNull(),
    totalDispensedQuantity: t
      .decimal("total_dispensed_quantity", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    dosageInstructions: t.text("dosage_instructions").notNull(),
    frequency: t.varchar({ length: 150 }),
    duration: t.varchar({ length: 150 }),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_prescription_items_prescription").on(table.prescriptionId),
      t
        .foreignKey({
          name: "fk_prescription_items_prescription",
          columns: [table.prescriptionId],
          foreignColumns: [prescriptions.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_prescription_items_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_prescription_items_qty",
        sql`${table.prescribedQuantity} > 0 AND ${table.totalDispensedQuantity} >= 0 AND ${table.totalDispensedQuantity} <= ${table.prescribedQuantity}`,
      ),
    ];
  },
);
