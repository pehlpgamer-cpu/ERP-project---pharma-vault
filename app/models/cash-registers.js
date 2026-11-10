import * as t from "drizzle-orm/mysql-core";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";

export const cashRegisters = t.mysqlTable(
  "cash_registers",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id").notNull(),
    name: t.varchar({ length: 100 }).notNull(),
    registerCode: t.varchar("register_code", { length: 50 }).notNull(),
    isActive: t.boolean("is_active").notNull().default(true),
  },
  (table) => {
    return [
      t.uniqueIndex("uq_register_branch_code").on(table.branchId, table.registerCode),
      t
        .foreignKey({
          name: "fk_registers_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
    ];
  },
);
