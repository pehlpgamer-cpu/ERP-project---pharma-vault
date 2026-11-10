import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { customers } from "./customers.js";
import { prescribingPhysicians } from "./prescribing-physicians.js";
import { users } from "./users.js";

export const prescriptions = t.mysqlTable(
  "prescriptions",
  {
    id: uuidPrimaryKey(),
    customerId: uuid("customer_id"),
    physicianId: uuid("physician_id").notNull(),
    prescriptionNumber: t.varchar("prescription_number", { length: 100 }),
    prescriptionDate: t.date("prescription_date").notNull(),
    validUntil: t.date("valid_until"),
    imagePath: t.varchar("image_path", { length: 500 }),
    status: t
      .mysqlEnum([
        "PENDING_VERIFICATION",
        "VERIFIED",
        "PARTIALLY_DISPENSED",
        "FULLY_DISPENSED",
        "REJECTED",
        "EXPIRED",
      ])
      .notNull()
      .default("PENDING_VERIFICATION"),
    verifiedBy: uuid("verified_by"),
    verifiedAt: t.datetime("verified_at"),
    ...timestamps,
  },
  (table) => {
    return [
      t.index("idx_prescriptions_customer").on(table.customerId),
      t.index("idx_prescriptions_date").on(table.prescriptionDate),
      t
        .foreignKey({
          name: "fk_prescriptions_customer",
          columns: [table.customerId],
          foreignColumns: [customers.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t
        .foreignKey({
          name: "fk_prescriptions_physician",
          columns: [table.physicianId],
          foreignColumns: [prescribingPhysicians.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_prescriptions_verifier",
          columns: [table.verifiedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      t.check(
        "chk_prescriptions_dates",
        sql`${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.prescriptionDate}`,
      ),
    ];
  },
);
