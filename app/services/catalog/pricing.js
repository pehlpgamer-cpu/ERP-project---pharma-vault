// Effective selling prices. A price row belongs to a product unit, optionally to one branch, and is
// effective from `effectiveFrom` up to (not including) `effectiveTo`.

import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { productPrices } from "../../models/product-prices.js";
import { cmp, toScale } from "../support/decimal.js";

const PRICE_SCALE = 4;

function isEffective(row, now) {
  return (
    row.isActive &&
    row.effectiveFrom.getTime() <= now.getTime() &&
    (row.effectiveTo === null || row.effectiveTo.getTime() > now.getTime())
  );
}

// Later start wins; on equal starts the lower price does, so a data error never overcharges.
function better(winner, row) {
  const byStart = row.effectiveFrom.getTime() - winner.effectiveFrom.getTime();

  if (byStart !== 0) {
    return byStart > 0 ? row : winner;
  }

  return cmp(row.unitPrice, winner.unitPrice) < 0 ? row : winner;
}

/**
 * The price in force at `now` for one unit, or null when there is none. A row for the branch beats a
 * row for every branch; within the same specificity the latest `effectiveFrom` wins.
 */
export function pickPrice(rows, branchId, now) {
  const candidates = rows.filter((row) => {
    return isEffective(row, now) && (row.branchId === null || row.branchId === branchId);
  });
  const forBranch = candidates.filter((row) => {
    return row.branchId !== null;
  });
  const pool = forBranch.length > 0 ? forBranch : candidates;

  if (pool.length === 0) {
    return null;
  }

  return toScale(pool.reduce(better).unitPrice, PRICE_SCALE);
}

/**
 * The effective price of each product unit for a branch, as a Map of unit id to a 4-place string.
 * Units without a price are left out. `executor` is `db` or a transaction.
 */
export async function loadEffectivePrices(executor, unitIds, branchId, now) {
  const prices = new Map();

  if (unitIds.length === 0) {
    return prices;
  }

  const rows = await executor
    .select()
    .from(productPrices)
    .where(
      and(
        inArray(productPrices.productUnitId, unitIds),
        eq(productPrices.isActive, true),
        lte(productPrices.effectiveFrom, now),
        or(isNull(productPrices.effectiveTo), gt(productPrices.effectiveTo, now)),
        branchId === null
          ? isNull(productPrices.branchId)
          : or(isNull(productPrices.branchId), eq(productPrices.branchId, branchId)),
      ),
    );
  const byUnit = Map.groupBy(rows, (row) => {
    return row.productUnitId;
  });

  for (const [unitId, unitRows] of byUnit) {
    const price = pickPrice(unitRows, branchId, now);

    if (price !== null) {
      prices.set(unitId, price);
    }
  }

  return prices;
}
