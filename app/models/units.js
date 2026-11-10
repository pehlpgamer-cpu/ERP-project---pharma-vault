import * as t from "drizzle-orm/mysql-core";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const units = t.mysqlTable(
  "units",
  {
    id: uuidPrimaryKey(),
    name: t.varchar({ length: 100 }).notNull(),
    abbreviation: t.varchar({ length: 30 }).notNull(),
  },
  (table) => {
    return [
      t.uniqueIndex("uq_units_name").on(table.name),
      t.uniqueIndex("uq_units_abbreviation").on(table.abbreviation),
    ];
  },
);
