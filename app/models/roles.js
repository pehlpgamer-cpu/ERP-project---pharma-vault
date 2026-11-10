import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const roles = t.mysqlTable(
  "roles",
  {
    id: uuidPrimaryKey(),
    name: t.varchar({ length: 100 }).notNull(),
    description: t.text(),
    ...timestamps,
  },
  (table) => {
    return [t.uniqueIndex("uq_roles_name").on(table.name)];
  },
);
