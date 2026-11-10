import * as t from "drizzle-orm/mysql-core";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { prescriptions } from "./prescriptions.js";
import { sales } from "./sales.js";
import { users } from "./users.js";

export const dispensings = t.mysqlTable(
  "dispensings",
  {
    id: uuidPrimaryKey(),
    prescriptionId: uuid("prescription_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    pharmacistId: uuid("pharmacist_id").notNull(),
    dispensedAt: t.datetime("dispensed_at").notNull(),
    status: t.mysqlEnum(["COMPLETED", "REVERSED"]).notNull().default("COMPLETED"),
    createdAt: t.timestamp("created_at").defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_dispensings_prescription").on(table.prescriptionId),
      t.index("idx_dispensings_sale").on(table.saleId),
      t
        .foreignKey({
          name: "fk_dispensings_prescription",
          columns: [table.prescriptionId],
          foreignColumns: [prescriptions.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_dispensings_sale",
          columns: [table.saleId],
          foreignColumns: [sales.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_dispensings_pharmacist",
          columns: [table.pharmacistId],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
    ];
  },
);
