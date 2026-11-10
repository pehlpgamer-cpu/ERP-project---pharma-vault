import * as t from "drizzle-orm/mysql-core";
import { uuid } from "./helpers/uuid.js";
import { roles } from "./roles.js";
import { permissions } from "./permissions.js";

export const rolePermissions = t.mysqlTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionId: uuid("permission_id").notNull(),
  },
  (table) => {
    return [
      t.primaryKey({ columns: [table.roleId, table.permissionId] }),
      t
        .foreignKey({
          name: "fk_role_permissions_role",
          columns: [table.roleId],
          foreignColumns: [roles.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
      t
        .foreignKey({
          name: "fk_role_permissions_permission",
          columns: [table.permissionId],
          foreignColumns: [permissions.id],
        })
        .onUpdate("cascade")
        .onDelete("cascade"),
    ];
  },
);
