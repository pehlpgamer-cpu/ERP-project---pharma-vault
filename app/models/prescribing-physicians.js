import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const prescribingPhysicians = t.mysqlTable(
  "prescribing_physicians",
  {
    id: uuidPrimaryKey(),
    fullName: t.varchar("full_name", { length: 255 }).notNull(),
    licenseNumber: t.varchar("license_number", { length: 100 }).notNull(),
    specialization: t.varchar({ length: 150 }),
    contactNumber: t.varchar("contact_number", { length: 50 }),
    ...timestamps,
  },
  (table) => {
    return [t.index("idx_physicians_license").on(table.licenseNumber)];
  },
);
