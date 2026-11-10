import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const customers = t.mysqlTable(
  "customers",
  {
    id: uuidPrimaryKey(),
    customerNumber: t.varchar("customer_number", { length: 50 }).notNull(),
    firstName: t.varchar("first_name", { length: 150 }).notNull(),
    lastName: t.varchar("last_name", { length: 150 }).notNull(),
    birthDate: t.date("birth_date"),
    contactNumber: t.varchar("contact_number", { length: 50 }),
    email: t.varchar({ length: 255 }),
    address: t.text(),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_customers_number").on(table.customerNumber),
      t.index("idx_customers_name").on(table.lastName, table.firstName),
    ];
  },
);
