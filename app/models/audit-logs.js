import * as t from "drizzle-orm/mysql-core";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { users } from "./users.js";

// Append-only by application policy; the schema alone does not prohibit updates/deletes.
export const auditLogs = t.mysqlTable(
  "audit_logs",
  {
    id: uuidPrimaryKey(),
    userId: uuid("user_id"),
    branchId: uuid("branch_id"),
    action: t.varchar({ length: 100 }).notNull(),
    entityType: t.varchar("entity_type", { length: 150 }).notNull(),
    entityId: uuid("entity_id"),
    oldValues: t.json("old_values"),
    newValues: t.json("new_values"),
    reason: t.text(),
    ipAddress: t.varchar("ip_address", { length: 45 }),
    userAgent: t.text("user_agent"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_audit_user_date").on(table.userId, table.createdAt),
      t.index("idx_audit_entity").on(table.entityType, table.entityId),
      t.index("idx_audit_branch_date").on(table.branchId, table.createdAt),
      t
        .foreignKey({ name: "fk_audit_user", columns: [table.userId], foreignColumns: [users.id] })
        .onUpdate("cascade")
        .onDelete("set null"),
      t
        .foreignKey({
          name: "fk_audit_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
    ];
  },
);
