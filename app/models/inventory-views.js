import { and, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { mysqlView } from "drizzle-orm/mysql-core";
import { inventories } from "./inventories.js";
import { inventoryBatches } from "./inventory-batches.js";
import { products } from "./products.js";

export const inventoryStock = mysqlView("v_inventory_stock").as((qb) => {
  return qb
    .select({
      inventoryId: sql`${inventories.id}`.as("inventory_id"),
      branchId: inventories.branchId,
      productId: inventories.productId,
      quantityOnHand: inventories.quantityOnHand,
      quantityReserved: inventories.quantityReserved,
      quantityAvailable: sql`${inventories.quantityOnHand} - ${inventories.quantityReserved}`.as(
        "quantity_available",
      ),
    })
    .from(inventories);
});

// Matches the supplied view: includes past-expiry batches and all statuses.
export const expiringInventory = mysqlView("v_expiring_inventory").as((qb) => {
  return qb
    .select({
      batchId: sql`${inventoryBatches.id}`.as("batch_id"),
      branchId: inventoryBatches.branchId,
      productId: inventoryBatches.productId,
      productName: products.productName,
      batchNumber: inventoryBatches.batchNumber,
      quantityAvailable: inventoryBatches.quantityAvailable,
      expirationDate: inventoryBatches.expirationDate,
      daysRemaining: sql`DATEDIFF(${inventoryBatches.expirationDate}, CURRENT_DATE)`.as(
        "days_remaining",
      ),
    })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(
      and(
        gt(inventoryBatches.quantityAvailable, "0"),
        isNotNull(inventoryBatches.expirationDate),
        lte(inventoryBatches.expirationDate, sql`DATE_ADD(CURRENT_DATE, INTERVAL 180 DAY)`),
      ),
    );
});
