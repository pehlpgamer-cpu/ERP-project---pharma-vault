import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";

export const users = t.mysqlTable(
  "users",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id"),
    name: t.varchar({ length: 255 }).notNull(),
    email: t.varchar({ length: 255 }).notNull(),
    employeeNumber: t.varchar("employee_number", { length: 50 }),
    password: t.varchar({ length: 255 }).notNull(),
    isActive: t.boolean("is_active").notNull().default(true),
    emailVerifiedAt: t.timestamp("email_verified_at"),
    rememberToken: t.varchar("remember_token", { length: 100 }),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_users_email").on(table.email),
      t.uniqueIndex("uq_users_employee_number").on(table.employeeNumber),
      t.index("idx_users_branch").on(table.branchId),
      t
        .foreignKey({
          name: "fk_users_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
    ];
  },
);
