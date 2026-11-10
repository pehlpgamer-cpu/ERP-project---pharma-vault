import * as t from "drizzle-orm/mysql-core";
import { uuid } from "./helpers/uuid.js";
import { sales } from "./sales.js";
import { prescriptions } from "./prescriptions.js";

export const salePrescriptions = t.mysqlTable(
  "sale_prescriptions",
  {
    saleId: uuid("sale_id").notNull(),
    prescriptionId: uuid("prescription_id").notNull(),
  },
  (table) => {
    return [
      t.primaryKey({ columns: [table.saleId, table.prescriptionId] }),
      t
        .foreignKey({
          name: "fk_sale_prescriptions_sale",
          columns: [table.saleId],
          foreignColumns: [sales.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_sale_prescriptions_prescription",
          columns: [table.prescriptionId],
          foreignColumns: [prescriptions.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
    ];
  },
);
