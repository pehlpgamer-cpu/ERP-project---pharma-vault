import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const permissions = t.mysqlTable(
  "permissions",
  {
    id: uuidPrimaryKey(),
    name: t.varchar({ length: 150 }).notNull(),
    description: t.text(),
    ...timestamps,
  },
  (table) => {
    return [t.uniqueIndex("uq_permissions_name").on(table.name)];
  },
);
