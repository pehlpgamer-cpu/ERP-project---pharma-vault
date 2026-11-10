import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const manufacturers = t.mysqlTable(
  "manufacturers",
  {
    id: uuidPrimaryKey(),
    name: t.varchar({ length: 255 }).notNull(),
    country: t.varchar({ length: 100 }),
    contactInformation: t.text("contact_information"),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [t.uniqueIndex("uq_manufacturers_name").on(table.name)];
  },
);
