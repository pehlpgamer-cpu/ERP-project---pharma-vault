// Write side of inventory: take a batch out of sale (quarantine), put it back (release), retire it
// for good (recall) or remove its stock (write-off). Every action locks the inventory row and then
// the batch row, the same order checkout uses, so a sale and an action on the same stock queue up
// instead of deadlocking, and each change is audited in the same transaction.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { recordAudit } from "../audit/auditLog.js";
import { cmp, sub, toScale } from "../support/decimal.js";
import { isUuid } from "../support/ids.js";

const MAX_REASON = 500;
const WRITE_OFF = {
  expired: { status: "EXPIRED", movement: "EXPIRED" },
  damaged: { status: "DEPLETED", movement: "DAMAGED" },
};

const notFound = () => {
  return new HttpError(404, "not_found", "Batch not found");
};

const wrongState = (message) => {
  return new HttpError(409, "batch_state", message);
};

function cleanReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";

  if (text === "" || text.length > MAX_REASON) {
    throw new ValidationError([
      { path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` },
    ]);
  }

  return text;
}

/**
 * Runs one action on a batch. `change(batch, inventory)` returns the new batch fields, the audit
 * action and (optionally) a movement to write, or throws 409 when the batch is in the wrong state.
 */
async function act(user, batchId, reason, change, { now = new Date(), meta = {} } = {}) {
  if (!isUuid(batchId)) {
    throw notFound();
  }

  return await db.transaction(
    async (tx) => {
      const [probe] = await tx
        .select({ inventoryId: inventoryBatches.inventoryId, branchId: inventoryBatches.branchId })
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, batchId));
      // Actions stay in the actor's own branch; other branches are view only, even for sales.view.all.
      if (!probe || probe.branchId !== user.branchId) {
        throw notFound();
      }

      // inventory row first, then the batch: the order checkout locks in
      const [inventory] = await tx
        .select()
        .from(inventories)
        .where(eq(inventories.id, probe.inventoryId))
        .for("update");
      const [batch] = await tx
        .select()
        .from(inventoryBatches)
        .where(eq(inventoryBatches.id, batchId))
        .for("update");

      if (!batch || !inventory) {
        throw notFound();
      }

      const result = change(batch, inventory);

      await tx.update(inventoryBatches).set(result.set).where(eq(inventoryBatches.id, batchId));

      if (result.removed) {
        await tx.insert(inventoryMovements).values({
          id: randomUUID(),
          branchId: batch.branchId,
          productId: batch.productId,
          inventoryBatchId: batch.id,
          movementType: result.movement,
          referenceType: "inventory_batch",
          referenceId: batch.id,
          quantityChange: sub("0", result.removed),
          quantityBefore: toScale(batch.quantityAvailable, 3),
          quantityAfter: toScale("0", 3),
          unitCost: batch.unitCost,
          reason,
          performedBy: user.id,
          createdAt: now,
        });
        await tx
          .update(inventories)
          .set({ quantityOnHand: toScale(sub(inventory.quantityOnHand, result.removed), 3) })
          .where(eq(inventories.id, inventory.id));
      }

      await recordAudit(tx, {
        userId: user.id,
        branchId: batch.branchId,
        action: result.action,
        entityType: "inventory_batch",
        entityId: batch.id,
        oldValues: { status: batch.status, quantityAvailable: toScale(batch.quantityAvailable, 3) },
        newValues: {
          status: result.set.status,
          quantityAvailable: result.set.quantityAvailable ?? toScale(batch.quantityAvailable, 3),
        },
        reason,
        ...meta,
      });

      return { batchId: batch.id, status: result.set.status };
    },
    { isolationLevel: "read committed" },
  );
}

const needs = (batch, allowed, verb) => {
  if (!allowed.includes(batch.status)) {
    throw wrongState(`A ${batch.status.toLowerCase()} batch cannot be ${verb}`);
  }
};

/** ACTIVE → QUARANTINED: held out of sale until released, recalled or written off. */
export async function quarantineBatch(user, batchId, input, options) {
  const text = cleanReason(input?.reason);

  return await act(
    user,
    batchId,
    text,
    (batch) => {
      needs(batch, ["ACTIVE"], "quarantined");

      return { action: "BATCH_QUARANTINED", set: { status: "QUARANTINED" } };
    },
    options,
  );
}

/** QUARANTINED → ACTIVE. */
export async function releaseBatch(user, batchId, input, options) {
  const text = cleanReason(input?.reason);

  return await act(
    user,
    batchId,
    text,
    (batch) => {
      needs(batch, ["QUARANTINED"], "released");

      // a batch with nothing left goes back to depleted, never to ACTIVE
      const status = cmp(batch.quantityAvailable, "0") > 0 ? "ACTIVE" : "DEPLETED";

      return { action: "BATCH_RELEASED", set: { status } };
    },
    options,
  );
}

/**
 * ACTIVE, QUARANTINED or DEPLETED → RECALLED, which is final. A sold-out lot can still be recalled: units
 * that come back from customers or arrive from a transfer must never make it sellable again.
 */
export async function recallBatch(user, batchId, input, options) {
  const text = cleanReason(input?.reason);

  return await act(
    user,
    batchId,
    text,
    (batch) => {
      needs(batch, ["ACTIVE", "QUARANTINED", "DEPLETED"], "recalled");

      return { action: "BATCH_RECALLED", set: { status: "RECALLED" } };
    },
    options,
  );
}

/**
 * Removes whatever stock an ACTIVE or QUARANTINED batch still holds. kind "expired" ends the batch
 * EXPIRED, kind "damaged" ends it DEPLETED; either way a movement and the on-hand total record it.
 */
export async function writeOffBatch(user, batchId, input, options) {
  const text = cleanReason(input?.reason);
  const kind = input?.kind;

  if (!Object.hasOwn(WRITE_OFF, kind ?? "")) {
    throw new ValidationError([{ path: "kind", message: "Choose expired or damaged" }]);
  }

  return await act(
    user,
    batchId,
    text,
    (batch) => {
      needs(batch, ["ACTIVE", "QUARANTINED"], "written off");

      if (cmp(batch.quantityAvailable, "0") <= 0) {
        throw wrongState("This batch holds no stock to write off");
      }

      const { status, movement } = WRITE_OFF[kind];

      return {
        action: "BATCH_WRITTEN_OFF",
        set: { status, quantityAvailable: toScale("0", 3) },
        movement,
        removed: toScale(batch.quantityAvailable, 3),
      };
    },
    options,
  );
}
