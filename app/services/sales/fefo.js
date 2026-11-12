// First-expiry-first-out batch allocation. Pure: it reads the batches it is given and returns a plan,
// so the checkout transaction decides what to lock and what to write.

import { cmp, min, sub, toScale } from "../support/decimal.js";
import { addDays, toDateString } from "../support/time.js";

const QUANTITY_SCALE = 3;

const isUndated = (batch) => {
  return batch.expirationDate === null || batch.expirationDate === undefined;
};

/**
 * A batch can be sold from when it is ACTIVE, holds stock, and either has no expiry date or expires
 * on or after today + bufferDays. A date that cannot be read is not eligible: stock of unknown age is
 * never sold.
 */
export function isEligibleBatch(batch, { today, bufferDays = 0 }) {
  if (batch.status !== "ACTIVE" || cmp(batch.quantityAvailable, "0") <= 0) {
    return false;
  }

  if (isUndated(batch)) {
    return true;
  }

  const expiry = toDateString(batch.expirationDate);

  return expiry !== null && expiry >= addDays(today, bufferDays);
}

function receivedTime(batch) {
  const time = new Date(batch.receivedAt).getTime();

  return Number.isNaN(time) ? 0 : time;
}

// Dated batches by expiry, then receipt, then id; undated batches after all of them.
function compareBatches(a, b) {
  const aExpiry = isUndated(a) ? null : toDateString(a.expirationDate);
  const bExpiry = isUndated(b) ? null : toDateString(b.expirationDate);

  if (aExpiry !== bExpiry) {
    if (aExpiry === null) {
      return 1;
    }

    if (bExpiry === null) {
      return -1;
    }

    return aExpiry < bExpiry ? -1 : 1;
  }

  if (receivedTime(a) !== receivedTime(b)) {
    return receivedTime(a) - receivedTime(b);
  }

  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? -1 : 1;
}

/**
 * Plans which batches cover `needed` base units, earliest expiry first.
 * Returns the batches to draw from and what could not be covered ("0.000" when everything was).
 */
export function allocateFefo(batches, needed, { today, bufferDays = 0 }) {
  const allocations = [];
  let remaining = toScale(needed, QUANTITY_SCALE);
  const eligible = batches
    .filter((batch) => {
      return isEligibleBatch(batch, { today, bufferDays });
    })
    .sort(compareBatches);

  for (const batch of eligible) {
    if (cmp(remaining, "0") <= 0) {
      break;
    }

    const quantity = min(remaining, toScale(batch.quantityAvailable, QUANTITY_SCALE));

    allocations.push({ batchId: batch.id, quantity });
    remaining = sub(remaining, quantity);
  }

  return {
    allocations,
    shortfall: cmp(remaining, "0") > 0 ? remaining : toScale("0", QUANTITY_SCALE),
  };
}
