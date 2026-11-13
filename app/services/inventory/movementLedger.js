// Read side of the stock movement ledger (inventory_movements, append-only by policy): newest first,
// filtered by type, date, product or batch, and branch. A user without the all-branch scope only ever
// sees their own branch, whatever branch the filter names.

import { and, count, desc, eq, gte, like, lt, or } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { branches } from "../../models/branches.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { products } from "../../models/products.js";
import { users } from "../../models/users.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { toScale } from "../support/decimal.js";
import { entityLink } from "../support/entityLinks.js";
import { isUuid } from "../support/ids.js";
import { isRealDay, startOfBusinessDay, startOfNextBusinessDay } from "../support/time.js";

const PAGE_SIZE = 50;

export const MOVEMENT_TYPES = [
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
];

const escapeLike = (value) => {
  return value.replace(/[\\%_]/g, (character) => {
    return `\\${character}`;
  });
};

/** Movements newest first. Filters: branchId (all-branch users only), type, q, from, to, page. */
export async function listMovements(user, filters = {}) {
  const conditions = [];
  const allBranches = can(user, PERMISSIONS.SALES_VIEW_ALL);

  if (!allBranches) {
    conditions.push(eq(inventoryMovements.branchId, user.branchId ?? ""));
  } else if (isUuid(filters.branchId)) {
    conditions.push(eq(inventoryMovements.branchId, filters.branchId));
  }

  if (MOVEMENT_TYPES.includes(filters.type)) {
    conditions.push(eq(inventoryMovements.movementType, filters.type));
  }

  if (isRealDay(filters.from)) {
    conditions.push(gte(inventoryMovements.createdAt, startOfBusinessDay(filters.from)));
  }

  if (isRealDay(filters.to)) {
    conditions.push(lt(inventoryMovements.createdAt, startOfNextBusinessDay(filters.to)));
  }

  if (typeof filters.q === "string" && filters.q.trim() !== "") {
    const needle = `%${escapeLike(filters.q.trim())}%`;

    conditions.push(
      or(
        like(products.sku, needle),
        like(products.productName, needle),
        like(inventoryBatches.batchNumber, needle),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const searching = typeof filters.q === "string" && filters.q.trim() !== "";
  const joined = (query) => {
    return query
      .from(inventoryMovements)
      .innerJoin(products, eq(products.id, inventoryMovements.productId))
      .innerJoin(inventoryBatches, eq(inventoryBatches.id, inventoryMovements.inventoryBatchId))
      .innerJoin(branches, eq(branches.id, inventoryMovements.branchId))
      .leftJoin(users, eq(users.id, inventoryMovements.performedBy))
      .where(where);
  };
  // only a product or lot search needs the product and batch joins to count
  const counting = db.select({ n: count() }).from(inventoryMovements);
  const [{ n }] = await (
    searching
      ? counting
          .innerJoin(products, eq(products.id, inventoryMovements.productId))
          .innerJoin(inventoryBatches, eq(inventoryBatches.id, inventoryMovements.inventoryBatchId))
      : counting
  ).where(where);
  const lastPage = Math.max(1, Math.ceil(n / PAGE_SIZE));
  const page =
    Number.isSafeInteger(filters.page) && filters.page > 0 ? Math.min(filters.page, lastPage) : 1;
  const rows = await joined(
    db.select({
      id: inventoryMovements.id,
      createdAt: inventoryMovements.createdAt,
      branchName: branches.name,
      productName: products.productName,
      sku: products.sku,
      batchNumber: inventoryBatches.batchNumber,
      movementType: inventoryMovements.movementType,
      quantityChange: inventoryMovements.quantityChange,
      quantityBefore: inventoryMovements.quantityBefore,
      quantityAfter: inventoryMovements.quantityAfter,
      unitCost: inventoryMovements.unitCost,
      reason: inventoryMovements.reason,
      referenceType: inventoryMovements.referenceType,
      referenceId: inventoryMovements.referenceId,
      performedByName: users.name,
    }),
  )
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  return {
    rows: rows.map((row) => {
      return {
        ...row,
        quantityChange: toScale(row.quantityChange, 3),
        quantityBefore: toScale(row.quantityBefore, 3),
        quantityAfter: toScale(row.quantityAfter, 3),
        unitCost: toScale(row.unitCost, 4),
        link: entityLink(row.referenceType, row.referenceId),
      };
    }),
    total: n,
    page,
    pageSize: PAGE_SIZE,
    allBranches,
  };
}
