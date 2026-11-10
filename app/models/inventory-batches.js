import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { inventories } from "./inventories.js";
import { products } from "./products.js";
import { branches } from "./branches.js";

export const inventoryBatches = t.mysqlTable(
  "inventory_batches",
  {
    id: uuidPrimaryKey(),
    inventoryId: uuid("inventory_id").notNull(),
    productId: uuid("product_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    batchNumber: t.varchar("batch_number", { length: 100 }).notNull(),
    expirationDate: t.date("expiration_date"),
    manufacturingDate: t.date("manufacturing_date"),
    quantityReceived: t.decimal("quantity_received", { precision: 14, scale: 3 }).notNull(),
    quantityAvailable: t.decimal("quantity_available", { precision: 14, scale: 3 }).notNull(),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull(),
    receivedAt: t.datetime("received_at").notNull(),
    status: t
      .mysqlEnum(["ACTIVE", "QUARANTINED", "EXPIRED", "DEPLETED", "RECALLED"])
      .notNull()
      .default("ACTIVE"),
    ...timestamps,
  },
  (table) => {
    return [
      t
        .index("idx_batches_fefo")
        .on(table.branchId, table.productId, table.status, table.expirationDate, table.receivedAt),
      t.index("idx_batches_inventory").on(table.inventoryId),
      t.index("idx_batches_batch_number").on(table.batchNumber),
      t
        .foreignKey({
          name: "fk_batches_inventory",
          columns: [table.inventoryId],
          foreignColumns: [inventories.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_batches_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_batches_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_batches_quantities",
        sql`${table.quantityReceived} >= 0 AND ${table.quantityAvailable} >= 0 AND ${table.quantityAvailable} <= ${table.quantityReceived}`,
      ),
      t.check("chk_batches_cost", sql`${table.unitCost} >= 0`),
      t.check(
        "chk_batches_dates",
        sql`${table.manufacturingDate} IS NULL OR ${table.expirationDate} IS NULL OR ${table.manufacturingDate} <= ${table.expirationDate}`,
      ),
    ];
  },
);
