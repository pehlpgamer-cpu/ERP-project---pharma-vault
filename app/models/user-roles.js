import * as t from "drizzle-orm/mysql-core";
import { uuid } from "./helpers/uuid.js";
import { users } from "./users.js";
import { roles } from "./roles.js";

export const userRoles = t.mysqlTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id").notNull(),
    assignedAt: t.timestamp("assigned_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      t.primaryKey({ columns: [table.userId, table.roleId] }),
      t
        .foreignKey({
          name: "fk_user_roles_user",
          columns: [table.userId],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
      t
        .foreignKey({
          name: "fk_user_roles_role",
          columns: [table.roleId],
          foreignColumns: [roles.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
    ];
  },
);
