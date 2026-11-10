import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const branches = t.mysqlTable(
  "branches",
  {
    id: uuidPrimaryKey(),
    name: t.varchar({ length: 255 }).notNull(),
    code: t.varchar({ length: 50 }).notNull(),
    address: t.text(),
    contactNumber: t.varchar("contact_number", { length: 30 }),
    email: t.varchar({ length: 255 }),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [t.uniqueIndex("uq_branches_code").on(table.code)];
  },
);
