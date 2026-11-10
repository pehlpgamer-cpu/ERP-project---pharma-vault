import * as t from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";
import { branches } from "./branches.js";
import { products } from "./products.js";
import { inventoryBatches } from "./inventory-batches.js";
import { users } from "./users.js";

// Append-only by application policy.
export const inventoryMovements = t.mysqlTable(
  "inventory_movements",
  {
    id: uuidPrimaryKey(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    inventoryBatchId: uuid("inventory_batch_id").notNull(),
    movementType: t
      .mysqlEnum("movement_type", [
        "PURCHASE_RECEIVED",
        "SALE",
        "SALE_RETURN",
        "PURCHASE_RETURN",
        "STOCK_ADJUSTMENT",
        "STOCK_TRANSFER_IN",
        "STOCK_TRANSFER_OUT",
        "EXPIRED",
        "DAMAGED",
        "REVERSAL",
      ])
      .notNull(),
    referenceType: t.varchar("reference_type", { length: 100 }),
    referenceId: uuid("reference_id"),
    quantityChange: t.decimal("quantity_change", { precision: 14, scale: 3 }).notNull(),
    quantityBefore: t.decimal("quantity_before", { precision: 14, scale: 3 }).notNull(),
    quantityAfter: t.decimal("quantity_after", { precision: 14, scale: 3 }).notNull(),
    unitCost: t.decimal("unit_cost", { precision: 14, scale: 4 }).notNull().default("0"),
    reason: t.text(),
    performedBy: uuid("performed_by").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      t.index("idx_movements_product_date").on(table.productId, table.createdAt),
      t.index("idx_movements_batch_date").on(table.inventoryBatchId, table.createdAt),
      t.index("idx_movements_reference").on(table.referenceType, table.referenceId),
      t
        .foreignKey({
          name: "fk_movements_branch",
          columns: [table.branchId],
          foreignColumns: [branches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_movements_product",
          columns: [table.productId],
          foreignColumns: [products.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_movements_batch",
          columns: [table.inventoryBatchId],
          foreignColumns: [inventoryBatches.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t
        .foreignKey({
          name: "fk_movements_user",
          columns: [table.performedBy],
          foreignColumns: [users.id],
        })
        .onUpdate("cascade")
        .onDelete("restrict"),
      t.check(
        "chk_movements_balance",
        sql`${table.quantityBefore} >= 0 AND ${table.quantityAfter} >= 0 AND ${table.quantityChange} = ${table.quantityAfter} - ${table.quantityBefore}`,
      ),
    ];
  },
);
