// Read side of inventory: what each branch holds, what it may actually sell, and which batches are
// low, expiring or expired. On hand is the recorded aggregate; sellable counts only batches that pass
// the same eligibility rule checkout uses.

import { and, asc, count, eq, gt, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError } from "../../http/errors.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";
import { units } from "../../models/units.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { isEligibleBatch } from "../sales/fefo.js";
import { add, cmp, toScale } from "../support/decimal.js";
import { isUuid } from "../support/ids.js";
import { expiryBufferDays } from "../support/settings.js";
import { addDays, businessDate, toDateString } from "../support/time.js";

const SOON_DAYS = 30;
const WINDOWS = { 30: 30, 60: 60, 90: 90 };
const FINISHED = ["DEPLETED", "EXPIRED"];

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

// LIKE treats \, % and _ specially: escape them so a search matches those characters literally.
const escapeLike = (text) => {
  return text.replace(/[\\%_]/g, "\\$&");
};

/**
 * The branch a user is looking at: their own, or (with the all-branch scope sales.view.all) the one
 * they ask for. Throws 403 otherwise.
 */
export function resolveBranch(user, branchId) {
  const everywhere = can(user, PERMISSIONS.SALES_VIEW_ALL);

  if (branchId && !isUuid(branchId)) {
    throw forbidden("Unknown branch");
  }

  if (branchId && branchId !== user.branchId && !everywhere) {
    throw forbidden("You can only see your own branch");
  }

  const resolved = branchId || user.branchId;

  if (!resolved) {
    throw forbidden("Choose a branch");
  }

  return resolved;
}

function textMatch(q, columns) {
  const pattern = `%${escapeLike(q.trim())}%`;

  return or(
    ...columns.map((column) => {
      return like(column, pattern);
    }),
  );
}

/**
 * One row per product stocked in the branch: on hand, sellable, reorder level and the flags low,
 * expiringSoon (an ACTIVE batch expires within 30 days) and expiredStock (stock past its date that
 * has not been written off). `flag` keeps rows with that flag: low, expiring or expired.
 */
export async function getStockOverview({ user, branchId, q, flag = "any", now = new Date() }) {
  const branch = resolveBranch(user, branchId);
  const today = businessDate(now);
  const horizon = addDays(today, SOON_DAYS);
  const rule = { today, bufferDays: expiryBufferDays() };
  const conditions = [eq(inventories.branchId, branch)];

  if (q && q.trim() !== "") {
    conditions.push(
      textMatch(q, [products.sku, products.productName, products.genericName, products.brandName]),
    );
  }

  const stocked = await db
    .select({
      productId: products.id,
      sku: products.sku,
      productName: products.productName,
      reorderLevel: products.reorderLevel,
      onHand: inventories.quantityOnHand,
      baseUnitName: units.name,
    })
    .from(inventories)
    .innerJoin(products, eq(products.id, inventories.productId))
    .leftJoin(
      productUnits,
      and(eq(productUnits.productId, products.id), eq(productUnits.isBaseUnit, true)),
    )
    .leftJoin(units, eq(units.id, productUnits.unitId))
    .where(and(...conditions))
    .orderBy(asc(products.productName), asc(products.sku));

  if (stocked.length === 0) {
    return { branchId: branch, rows: [] };
  }

  const batches = await db
    .select({
      productId: inventoryBatches.productId,
      status: inventoryBatches.status,
      quantityAvailable: inventoryBatches.quantityAvailable,
      expirationDate: inventoryBatches.expirationDate,
    })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.branchId, branch),
        inArray(
          inventoryBatches.productId,
          stocked.map((row) => {
            return row.productId;
          }),
        ),
        gt(inventoryBatches.quantityAvailable, "0"),
      ),
    );
  const byProduct = Map.groupBy(batches, (batch) => {
    return batch.productId;
  });
  const rows = stocked.map((row) => {
    const own = byProduct.get(row.productId) ?? [];
    const sellable = own
      .filter((batch) => {
        return isEligibleBatch(batch, rule);
      })
      .reduce((total, batch) => {
        return add(total, batch.quantityAvailable);
      }, "0");

    return {
      productId: row.productId,
      sku: row.sku,
      productName: row.productName,
      baseUnitName: row.baseUnitName,
      onHand: toScale(row.onHand, 3),
      sellable: toScale(sellable, 3),
      reorderLevel: row.reorderLevel,
      low: cmp(sellable, row.reorderLevel) < 0,
      expiringSoon: own.some((batch) => {
        const expiry = toDateString(batch.expirationDate);

        return batch.status === "ACTIVE" && expiry !== null && expiry >= today && expiry <= horizon;
      }),
      expiredStock: own.some((batch) => {
        const expiry = toDateString(batch.expirationDate);

        return expiry !== null && expiry < today && !FINISHED.includes(batch.status);
      }),
    };
  });
  const wanted = { low: "low", expiring: "expiringSoon", expired: "expiredStock" }[flag];

  return {
    branchId: branch,
    rows: wanted
      ? rows.filter((row) => {
          return row[wanted];
        })
      : rows,
  };
}

/**
 * A page of the branch's batches, soonest expiry first (undated last). `expiry`: expired, 30, 60 or
 * 90 (days from today), or any.
 */
export async function listBatches({
  user,
  branchId,
  q,
  status,
  expiry = "any",
  page = 1,
  perPage = 20,
  now = new Date(),
}) {
  const branch = resolveBranch(user, branchId);
  const today = businessDate(now);
  const conditions = [eq(inventoryBatches.branchId, branch)];

  if (status) {
    conditions.push(eq(inventoryBatches.status, status));
  }

  if (expiry === "expired") {
    conditions.push(sql`${inventoryBatches.expirationDate} < ${today}`);
  } else if (WINDOWS[expiry]) {
    conditions.push(
      sql`${inventoryBatches.expirationDate} >= ${today} AND ${inventoryBatches.expirationDate} <= ${addDays(today, WINDOWS[expiry])}`,
    );
  }

  if (q && q.trim() !== "") {
    conditions.push(
      textMatch(q, [
        products.sku,
        products.productName,
        products.genericName,
        inventoryBatches.batchNumber,
      ]),
    );
  }

  const where = and(...conditions);
  const [{ total }] = await db
    .select({ total: count() })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(where);
  const found = await db
    .select({
      id: inventoryBatches.id,
      productId: products.id,
      sku: products.sku,
      productName: products.productName,
      batchNumber: inventoryBatches.batchNumber,
      expirationDate: inventoryBatches.expirationDate,
      quantityAvailable: inventoryBatches.quantityAvailable,
      status: inventoryBatches.status,
      receivedAt: inventoryBatches.receivedAt,
    })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(where)
    .orderBy(
      sql`${inventoryBatches.expirationDate} IS NULL`,
      asc(inventoryBatches.expirationDate),
      asc(products.productName),
      asc(inventoryBatches.batchNumber),
      asc(inventoryBatches.id),
    )
    .limit(perPage)
    .offset((page - 1) * perPage);

  return {
    total: Number(total),
    rows: found.map((row) => {
      return { ...row, expirationDate: toDateString(row.expirationDate) };
    }),
  };
}
