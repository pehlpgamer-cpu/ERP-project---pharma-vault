import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuidPrimaryKey } from "./helpers/uuid.js";

export const suppliers = t.mysqlTable(
  "suppliers",
  {
    id: uuidPrimaryKey(),
    code: t.varchar({ length: 50 }).notNull(),
    name: t.varchar({ length: 255 }).notNull(),
    contactName: t.varchar("contact_name", { length: 255 }),
    phone: t.varchar({ length: 50 }),
    email: t.varchar({ length: 255 }),
    taxId: t.varchar("tax_id", { length: 100 }),
    paymentTerms: t.varchar("payment_terms", { length: 255 }),
    address: t.text(),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_suppliers_code").on(table.code),
      t.index("idx_suppliers_name").on(table.name),
    ];
  },
);
