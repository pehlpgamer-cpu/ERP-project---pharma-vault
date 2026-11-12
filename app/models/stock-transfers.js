import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { users } from "./users.js";

export const stockTransfers = t.mysqlTable(
  "stock_transfers",
  {
    id: uuidPrimaryKey(),
    transferNumber: t.varchar("transfer_number", { length: 100 }).notNull(),
    sourceBranchId: uuid("source_branch_id").notNull(),
    destinationBranchId: uuid("destination_branch_id").notNull(),
    status: t
      .mysqlEnum([
        "DRAFT",
        "PENDING_APPROVAL",
        "APPROVED",
        "IN_TRANSIT",
        "PARTIALLY_RECEIVED",
        "RECEIVED",
        "REJECTED",
        "CANCELLED",
      ])
      .notNull()
      .default("DRAFT"),
    requestedBy: uuid("requested_by").notNull(),
    approvedBy: uuid("approved_by"),
    shippedAt: t.datetime("shipped_at"),
    receivedAt: t.datetime("received_at"),
    ...timestamps,
  },
  (table) => {
    return [
      t.uniqueIndex("uq_stock_transfers_number").on(table.transferNumber),
      t
        .foreignKey({
          name: "fk_transfers_source",
          columns: [table.sourceBranchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("restrict")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfers_destination",
          columns: [table.destinationBranchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("restrict")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfers_requester",
          columns: [table.requestedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_transfers_approver",
          columns: [table.approvedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
      // MySQL rejects a CHECK on columns whose foreign key has ON UPDATE CASCADE,
      // so the two branch foreign keys above restrict updates instead (ids are never updated).
      t.check(
        "chk_transfer_branches",
        sql`${table.sourceBranchId} <> ${table.destinationBranchId}`,
      ),
    ];
  },
);
