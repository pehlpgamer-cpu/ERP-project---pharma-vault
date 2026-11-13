// Interbranch stock transfers. The destination branch requests batches from a source branch; the
// source's approver approves; the source dispatches (stock leaves its batches and is in transit, on
// nobody's books); the destination receives, which creates its own batch carrying the source batch's
// lot, dates and unit cost. Every step locks the transfer, checks the actor is on the right side and
// re-checks its state. Dispatch locks inventory rows then batches in id order, like checkout.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { products } from "../../models/products.js";
import { stockTransferItems } from "../../models/stock-transfer-items.js";
import { stockTransfers } from "../../models/stock-transfers.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { nextDocumentNumber } from "../purchasing/numbers.js";
import { add, cmp, sub, sum, toScale } from "../support/decimal.js";
import { isDeadlock } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";
import { businessDate, toDateString } from "../support/time.js";

const MAX_LINES = 100;
const MAX_REASON = 500;
const PAGE_SIZE = 25;
const BATCH_CHOICES = 500;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;

export const TRANSFER_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "IN_TRANSIT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "REJECTED",
  "CANCELLED",
];

const notFound = () => {
  return new HttpError(404, "not_found", "Transfer not found");
};

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

const invalid = (path, message) => {
  return new ValidationError([{ path, message }]);
};

const isBlank = (value) => {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
};

const manages = (user) => {
  return can(user, PERMISSIONS.TRANSFERS_MANAGE);
};

// ---- drafting ----

const isShippable = (batch, today) => {
  const expiry = toDateString(batch.expirationDate);

  return batch.status === "ACTIVE" && (expiry === null || expiry >= today);
};

async function checkDraft(tx, user, input, today) {
  const errors = [];
  const sourceId = input?.sourceBranchId;
  let source = null;

  if (!isUuid(sourceId) || sourceId === user.branchId) {
    errors.push({ path: "sourceBranchId", message: "Choose another branch to request from" });
  } else {
    [source] = await tx.select().from(branches).where(eq(branches.id, sourceId));

    if (!source) {
      errors.push({ path: "sourceBranchId", message: "Choose another branch to request from" });
    }
  }

  const rawLines = Array.isArray(input?.lines) ? input.lines : [];
  const filled = rawLines
    .map((line, index) => {
      return { line, index };
    })
    .filter(({ line }) => {
      return !(isBlank(line?.sourceBatchId) && isBlank(line?.quantity));
    });

  if (filled.length === 0 || filled.length > MAX_LINES || rawLines.length > MAX_LINES * 2) {
    errors.push({ path: "lines", message: `Request 1 to ${MAX_LINES} batches` });
  }

  const wanted = filled
    .slice(0, MAX_LINES)
    .map(({ line }) => {
      return line.sourceBatchId;
    })
    .filter(isUuid);
  const found =
    wanted.length === 0
      ? []
      : await tx.select().from(inventoryBatches).where(inArray(inventoryBatches.id, wanted));
  const byId = new Map(
    found.map((batch) => {
      return [batch.id, batch];
    }),
  );
  const seen = new Set();
  const rows = [];

  if (filled.length <= MAX_LINES && rawLines.length <= MAX_LINES * 2) {
    for (const { line, index } of filled) {
      const batch = isUuid(line.sourceBatchId) ? byId.get(line.sourceBatchId) : undefined;
      const text = typeof line.quantity === "string" ? line.quantity.trim() : "";
      let ok = true;

      if (!batch || !source || batch.branchId !== source.id) {
        errors.push({ path: `lines.${index}.sourceBatchId`, message: "Choose a batch" });
        continue;
      }

      if (seen.has(batch.id)) {
        errors.push({
          path: `lines.${index}.sourceBatchId`,
          message: "This batch is already on the transfer",
        });
        continue;
      }

      seen.add(batch.id);

      if (!isShippable(batch, today)) {
        errors.push({
          path: `lines.${index}.sourceBatchId`,
          message: "This batch is not available to transfer (inactive or expired)",
        });
        ok = false;
      }

      if (!QUANTITY.test(text) || cmp(text, "0") <= 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: "Enter a quantity above 0, up to 3 decimals",
        });
        ok = false;
      } else if (cmp(text, batch.quantityAvailable) > 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: `Only ${toScale(batch.quantityAvailable, 3)} available in this batch`,
        });
        ok = false;
      }

      if (ok) {
        rows.push({ batch, quantity: toScale(text, 3) });
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return { source, rows };
}

function cleanReason(input, required) {
  const text = typeof input?.reason === "string" ? input.reason.trim() : "";

  if ((required && text === "") || text.length > MAX_REASON) {
    throw invalid("reason", `Give a reason of 1 to ${MAX_REASON} characters`);
  }

  return text === "" ? null : text;
}

/** A new DRAFT request from the actor's branch to `sourceBranchId`. Returns { id, transferNumber }. */
export async function createTransfer(user, input, { now = new Date(), meta = {} } = {}) {
  if (!manages(user)) {
    throw forbidden("You do not have permission to request transfers");
  }

  if (!user.branchId) {
    throw forbidden("Transfers belong to a branch, and this account has none");
  }

  return await db.transaction(
    async (tx) => {
      const today = businessDate(now);
      const draft = await checkDraft(tx, user, input, today);
      const id = randomUUID();
      const transferNumber = await nextDocumentNumber(tx, "TRF", user.branchCode, today);

      await tx.insert(stockTransfers).values({
        id,
        transferNumber,
        sourceBranchId: draft.source.id,
        destinationBranchId: user.branchId,
        status: "DRAFT",
        requestedBy: user.id,
      });
      await tx.insert(stockTransferItems).values(
        draft.rows.map(({ batch, quantity }) => {
          return {
            id: randomUUID(),
            stockTransferId: id,
            productId: batch.productId,
            sourceInventoryBatchId: batch.id,
            quantityRequested: quantity,
          };
        }),
      );
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "TRANSFER_CREATED",
        entityType: "stock_transfer",
        entityId: id,
        newValues: { transferNumber, from: draft.source.code, lines: draft.rows.length },
        ...meta,
      });

      return { id, transferNumber };
    },
    { isolationLevel: "read committed" },
  );
}

// ---- steps ----

/**
 * Locks the transfer and checks the actor is on the right `side` ("source" or "destination"; a
 * user of neither branch gets a 404) and the transfer is in one of the `from` states.
 */
async function lockTransfer(tx, user, id, { side, from, verb }) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await tx
    .select()
    .from(stockTransfers)
    .where(eq(stockTransfers.id, id))
    .for("update");

  if (!row || ![row.sourceBranchId, row.destinationBranchId].includes(user.branchId)) {
    throw notFound();
  }

  const wanted = side === "source" ? row.sourceBranchId : row.destinationBranchId;

  if (side && user.branchId !== wanted) {
    throw forbidden(`Only the ${side} branch can do this`);
  }

  if (!from.includes(row.status)) {
    throw new HttpError(
      409,
      "transfer_state",
      `A ${row.status.toLowerCase().replaceAll("_", " ")} transfer cannot be ${verb}`,
    );
  }

  return row;
}

async function move(user, id, input, rule, { now = new Date(), meta = {} } = {}) {
  const reason = cleanReason(input, rule.reason === "required");

  if (!can(user, ...rule.needs)) {
    throw forbidden("You do not have permission for this step");
  }

  return await db.transaction(
    async (tx) => {
      const row = await lockTransfer(tx, user, id, rule);

      if (rule.guard && !rule.guard(user, row)) {
        throw forbidden("You do not have permission for this step");
      }

      await tx
        .update(stockTransfers)
        .set({ status: rule.to, ...rule.set?.(user, now) })
        .where(eq(stockTransfers.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "stock_transfer",
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: rule.to },
        reason,
        ...meta,
      });

      return { id, status: rule.to };
    },
    { isolationLevel: "read committed" },
  );
}

const RULES = {
  submit: {
    side: "destination",
    from: ["DRAFT"],
    to: "PENDING_APPROVAL",
    verb: "submitted",
    action: "TRANSFER_SUBMITTED",
    needs: [PERMISSIONS.TRANSFERS_MANAGE],
  },
  approve: {
    side: "source",
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    verb: "approved",
    action: "TRANSFER_APPROVED",
    needs: [PERMISSIONS.TRANSFERS_APPROVE],
    set: (user) => {
      return { approvedBy: user.id };
    },
  },
  reject: {
    side: "source",
    from: ["PENDING_APPROVAL"],
    to: "REJECTED",
    verb: "rejected",
    action: "TRANSFER_REJECTED",
    needs: [PERMISSIONS.TRANSFERS_APPROVE],
    reason: "required",
  },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
    to: "CANCELLED",
    verb: "cancelled",
    action: "TRANSFER_CANCELLED",
    needs: [PERMISSIONS.TRANSFERS_MANAGE, PERMISSIONS.TRANSFERS_APPROVE],
    reason: "required",
    // the requester calls off its own request; the source's approver may call off an approved one
    guard: (user, row) => {
      return (
        (user.branchId === row.destinationBranchId && manages(user)) ||
        (user.branchId === row.sourceBranchId && can(user, PERMISSIONS.TRANSFERS_APPROVE))
      );
    },
  },
  close: {
    side: "destination",
    from: ["IN_TRANSIT", "PARTIALLY_RECEIVED"],
    to: "RECEIVED",
    verb: "closed",
    action: "TRANSFER_CLOSED_SHORT",
    needs: [PERMISSIONS.TRANSFERS_MANAGE],
    reason: "required",
    set: (user, now) => {
      return { receivedAt: now };
    },
  },
};

export const submitTransfer = (user, id, input, options) => {
  return move(user, id, input, RULES.submit, options);
};
export const approveTransfer = (user, id, input, options) => {
  return move(user, id, input, RULES.approve, options);
};
export const rejectTransfer = (user, id, input, options) => {
  return move(user, id, input, RULES.reject, options);
};
export const cancelTransfer = (user, id, input, options) => {
  return move(user, id, input, RULES.cancel, options);
};
/** Closes a transfer whose rest will not arrive (lost or damaged), recording why. */
export const closeTransfer = (user, id, input, options) => {
  return move(user, id, input, RULES.close, options);
};

// ---- dispatch and receipt ----

// retries a step that lost a deadlock to a sale (nothing was written)
async function withRetry(step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!isDeadlock(error) || attempt >= 3) {
        throw error;
      }
    }
  }
}

const lineMap = (input) => {
  const lines = Array.isArray(input?.lines) ? input.lines : [];

  return new Map(
    lines.map((line, index) => {
      return [line?.itemId, { quantity: line?.quantity, index }];
    }),
  );
};

/**
 * APPROVED → IN_TRANSIT at the source. `input.lines` is `[{ itemId, quantity }]`: the quantity really
 * shipped for every line, 0 to the quantity requested, at least one above 0.
 */
export async function dispatchTransfer(user, id, input, options = {}) {
  if (!manages(user)) {
    throw forbidden("You do not have permission to dispatch transfers");
  }

  return await withRetry(() => {
    return dispatchOnce(user, id, input, options);
  });
}

const staleStock = (message) => {
  return new HttpError(409, "transfer_stock", message);
};

async function dispatchOnce(user, id, input, { now = new Date(), meta = {} }) {
  return await db.transaction(
    async (tx) => {
      const transfer = await lockTransfer(tx, user, id, {
        side: "source",
        from: ["APPROVED"],
        verb: "dispatched",
      });
      const items = await tx
        .select()
        .from(stockTransferItems)
        .where(eq(stockTransferItems.stockTransferId, id))
        .orderBy(asc(stockTransferItems.sourceInventoryBatchId));
      const given = lineMap(input);
      const errors = [];
      const shipped = new Map();

      for (const item of items) {
        const entry = given.get(item.id);
        const text = typeof entry?.quantity === "string" ? entry.quantity.trim() : "";

        if (!entry) {
          errors.push({ path: "lines", message: "Give the shipped quantity of every line" });
        } else if (!QUANTITY.test(text) || cmp(text, item.quantityRequested) > 0) {
          errors.push({
            path: `lines.${entry.index}.quantity`,
            message: `Enter 0 to ${toScale(item.quantityRequested, 3)}`,
          });
        } else {
          shipped.set(item.id, toScale(text, 3));
        }
      }

      const anyShipped = [...shipped.values()].some((value) => {
        return cmp(value, "0") > 0;
      });

      if (errors.length === 0 && !anyShipped) {
        errors.push({ path: "lines", message: "Ship at least one line" });
      }

      if (errors.length > 0) {
        throw new ValidationError(errors);
      }

      const sending = items.filter((item) => {
        return cmp(shipped.get(item.id), "0") > 0;
      });
      const batchIds = sending.map((item) => {
        return item.sourceInventoryBatchId;
      });
      const probes = await tx
        .select({ inventoryId: inventoryBatches.inventoryId })
        .from(inventoryBatches)
        .where(inArray(inventoryBatches.id, batchIds));
      const stocks = await tx
        .select()
        .from(inventories)
        .where(
          inArray(
            inventories.id,
            probes.map((probe) => {
              return probe.inventoryId;
            }),
          ),
        )
        .orderBy(asc(inventories.productId))
        .for("update");
      const batches = await tx
        .select()
        .from(inventoryBatches)
        .where(inArray(inventoryBatches.id, batchIds))
        .orderBy(asc(inventoryBatches.id))
        .for("update");
      const stockById = new Map(
        stocks.map((stock) => {
          return [stock.id, stock];
        }),
      );
      const batchById = new Map(
        batches.map((batch) => {
          return [batch.id, batch];
        }),
      );
      const today = businessDate(now);
      const taken = new Map();

      for (const item of sending) {
        const batch = batchById.get(item.sourceInventoryBatchId);
        const quantity = shipped.get(item.id);

        if (!batch || !isShippable(batch, today) || cmp(batch.quantityAvailable, quantity) < 0) {
          throw staleStock(
            `Batch ${batch?.batchNumber ?? "(removed)"} cannot ship ${quantity} now. Cancel this transfer and request again.`,
          );
        }

        const after = toScale(sub(batch.quantityAvailable, quantity), 3);

        await tx
          .update(inventoryBatches)
          .set({
            quantityAvailable: after,
            status: cmp(after, "0") === 0 ? "DEPLETED" : batch.status,
          })
          .where(eq(inventoryBatches.id, batch.id));
        await tx.insert(inventoryMovements).values({
          id: randomUUID(),
          branchId: batch.branchId,
          productId: batch.productId,
          inventoryBatchId: batch.id,
          movementType: "STOCK_TRANSFER_OUT",
          referenceType: "stock_transfer",
          referenceId: id,
          quantityChange: sub("0", quantity),
          quantityBefore: toScale(batch.quantityAvailable, 3),
          quantityAfter: after,
          unitCost: batch.unitCost,
          reason: `Shipped on ${transfer.transferNumber}`,
          performedBy: user.id,
          createdAt: now,
        });
        taken.set(batch.inventoryId, add(taken.get(batch.inventoryId) ?? "0", quantity));
      }

      for (const [inventoryId, quantity] of taken) {
        const next = sub(stockById.get(inventoryId).quantityOnHand, quantity);

        if (cmp(next, "0") < 0) {
          throw staleStock(
            "The on-hand total no longer covers this transfer. Cancel it and request again.",
          );
        }

        await tx
          .update(inventories)
          .set({ quantityOnHand: toScale(next, 3) })
          .where(eq(inventories.id, inventoryId));
      }

      for (const item of items) {
        await tx
          .update(stockTransferItems)
          .set({ quantityShipped: shipped.get(item.id) })
          .where(eq(stockTransferItems.id, item.id));
      }

      await tx
        .update(stockTransfers)
        .set({ status: "IN_TRANSIT", shippedAt: now })
        .where(eq(stockTransfers.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "TRANSFER_DISPATCHED",
        entityType: "stock_transfer",
        entityId: id,
        oldValues: { status: "APPROVED" },
        newValues: {
          status: "IN_TRANSIT",
          shipped: toScale(sum([...shipped.values()]), 3),
          requested: toScale(
            sum(
              items.map((item) => {
                return item.quantityRequested;
              }),
            ),
            3,
          ),
        },
        ...meta,
      });

      return { id, status: "IN_TRANSIT" };
    },
    { isolationLevel: "read committed" },
  );
}

/** Makes sure the product has an inventory row in the branch and locks it. */
async function lockInventory(tx, branchId, productId) {
  await tx
    .insert(inventories)
    .values({ branchId, productId })
    .onDuplicateKeyUpdate({ set: { quantityOnHand: sql`${inventories.quantityOnHand}` } });

  const [row] = await tx
    .select()
    .from(inventories)
    .where(and(eq(inventories.branchId, branchId), eq(inventories.productId, productId)))
    .for("update");

  return row;
}

/**
 * IN_TRANSIT or PARTIALLY_RECEIVED → PARTIALLY_RECEIVED or RECEIVED at the destination.
 * `input.lines` is `[{ itemId, quantity }]`: what arrived per line (blank lines are skipped), up to
 * what was shipped less what was already received, at least one above 0.
 */
export async function receiveTransfer(user, id, input, options = {}) {
  if (!manages(user)) {
    throw forbidden("You do not have permission to receive transfers");
  }

  return await withRetry(() => {
    return receiveOnce(user, id, input, options);
  });
}

async function receiveOnce(user, id, input, { now = new Date(), meta = {} }) {
  return await db.transaction(
    async (tx) => {
      const transfer = await lockTransfer(tx, user, id, {
        side: "destination",
        from: ["IN_TRANSIT", "PARTIALLY_RECEIVED"],
        verb: "received",
      });
      const items = await tx
        .select()
        .from(stockTransferItems)
        .where(eq(stockTransferItems.stockTransferId, id))
        .orderBy(asc(stockTransferItems.productId), asc(stockTransferItems.id));
      const given = lineMap(input);
      const errors = [];
      const arriving = new Map();

      for (const item of items) {
        const entry = given.get(item.id);

        if (!entry || isBlank(entry.quantity)) {
          continue;
        }

        const text = typeof entry.quantity === "string" ? entry.quantity.trim() : "";
        const open = sub(item.quantityShipped, item.quantityReceived);

        if (!QUANTITY.test(text) || cmp(text, "0") < 0) {
          errors.push({
            path: `lines.${entry.index}.quantity`,
            message: "Enter the quantity that arrived, up to 3 decimals",
          });
        } else if (cmp(text, open) > 0) {
          errors.push({
            path: `lines.${entry.index}.quantity`,
            message: `Only ${toScale(open, 3)} is still to arrive`,
          });
        } else if (cmp(text, "0") > 0) {
          arriving.set(item.id, toScale(text, 3));
        }
      }

      if (errors.length === 0 && arriving.size === 0) {
        errors.push({ path: "lines", message: "Enter what arrived for at least one line" });
      }

      if (errors.length > 0) {
        throw new ValidationError(errors);
      }

      const stock = new Map();
      const received = new Map();

      for (const item of items) {
        if (!arriving.has(item.id)) {
          continue;
        }

        const quantity = arriving.get(item.id);
        const inventory =
          stock.get(item.productId) ??
          (await lockInventory(tx, transfer.destinationBranchId, item.productId));

        stock.set(item.productId, inventory);

        let batchId = item.destinationInventoryBatchId;
        let before = "0.000";

        if (batchId === null) {
          const [source] = await tx
            .select()
            .from(inventoryBatches)
            .where(eq(inventoryBatches.id, item.sourceInventoryBatchId));

          batchId = randomUUID();
          await tx.insert(inventoryBatches).values({
            id: batchId,
            inventoryId: inventory.id,
            productId: item.productId,
            branchId: transfer.destinationBranchId,
            batchNumber: source.batchNumber,
            expirationDate: source.expirationDate,
            manufacturingDate: source.manufacturingDate,
            quantityReceived: quantity,
            quantityAvailable: quantity,
            unitCost: source.unitCost,
            receivedAt: now,
            status: "ACTIVE",
          });
        } else {
          const [batch] = await tx
            .select()
            .from(inventoryBatches)
            .where(eq(inventoryBatches.id, batchId))
            .for("update");

          before = toScale(batch.quantityAvailable, 3);
          await tx
            .update(inventoryBatches)
            .set({
              quantityReceived: toScale(add(batch.quantityReceived, quantity), 3),
              quantityAvailable: toScale(add(before, quantity), 3),
              status: batch.status === "DEPLETED" ? "ACTIVE" : batch.status,
            })
            .where(eq(inventoryBatches.id, batchId));
        }

        const [{ unitCost }] = await tx
          .select({ unitCost: inventoryBatches.unitCost })
          .from(inventoryBatches)
          .where(eq(inventoryBatches.id, batchId));

        await tx.insert(inventoryMovements).values({
          id: randomUUID(),
          branchId: transfer.destinationBranchId,
          productId: item.productId,
          inventoryBatchId: batchId,
          movementType: "STOCK_TRANSFER_IN",
          referenceType: "stock_transfer",
          referenceId: id,
          quantityChange: quantity,
          quantityBefore: before,
          quantityAfter: toScale(add(before, quantity), 3),
          unitCost,
          reason: `Received on ${transfer.transferNumber}`,
          performedBy: user.id,
          createdAt: now,
        });
        await tx
          .update(stockTransferItems)
          .set({
            quantityReceived: toScale(add(item.quantityReceived, quantity), 3),
            destinationInventoryBatchId: batchId,
          })
          .where(eq(stockTransferItems.id, item.id));
        received.set(item.id, toScale(add(item.quantityReceived, quantity), 3));
        inventory.onHand = add(inventory.onHand ?? inventory.quantityOnHand, quantity);
      }

      for (const inventory of stock.values()) {
        await tx
          .update(inventories)
          .set({ quantityOnHand: toScale(inventory.onHand, 3) })
          .where(eq(inventories.id, inventory.id));
      }

      const complete = items.every((item) => {
        const total = received.get(item.id) ?? item.quantityReceived;

        return cmp(total, item.quantityShipped) === 0;
      });
      const status = complete ? "RECEIVED" : "PARTIALLY_RECEIVED";

      await tx
        .update(stockTransfers)
        .set({ status, ...(complete ? { receivedAt: now } : {}) })
        .where(eq(stockTransfers.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "TRANSFER_RECEIVED",
        entityType: "stock_transfer",
        entityId: id,
        oldValues: { status: transfer.status },
        newValues: {
          status,
          arrived: toScale(sum([...arriving.values()]), 3),
        },
        ...meta,
      });

      return { id, status };
    },
    { isolationLevel: "read committed" },
  );
}

// ---- reading ----

const sourceBranch = alias(branches, "source_branch");
const destinationBranch = alias(branches, "destination_branch");
const approvers = alias(users, "approvers");

const headerSelect = {
  id: stockTransfers.id,
  transferNumber: stockTransfers.transferNumber,
  status: stockTransfers.status,
  sourceBranchId: stockTransfers.sourceBranchId,
  sourceBranchName: sourceBranch.name,
  destinationBranchId: stockTransfers.destinationBranchId,
  destinationBranchName: destinationBranch.name,
  requestedBy: stockTransfers.requestedBy,
  requestedByName: users.name,
  approvedByName: approvers.name,
  shippedAt: stockTransfers.shippedAt,
  receivedAt: stockTransfers.receivedAt,
  createdAt: stockTransfers.createdAt,
};

function headerQuery(executor) {
  return executor
    .select(headerSelect)
    .from(stockTransfers)
    .innerJoin(sourceBranch, eq(sourceBranch.id, stockTransfers.sourceBranchId))
    .innerJoin(destinationBranch, eq(destinationBranch.id, stockTransfers.destinationBranchId))
    .innerJoin(users, eq(users.id, stockTransfers.requestedBy))
    .leftJoin(approvers, eq(approvers.id, stockTransfers.approvedBy));
}

const sees = (user, transfer) => {
  return (
    [transfer.sourceBranchId, transfer.destinationBranchId].includes(user.branchId) ||
    can(user, PERMISSIONS.SALES_VIEW_ALL)
  );
};

/** One transfer with its lines. A user of neither branch gets a 404 (unless all-branch scope). */
export async function getTransfer(user, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [transfer] = await headerQuery(db).where(eq(stockTransfers.id, id));

  if (!transfer || !sees(user, transfer)) {
    throw notFound();
  }

  const lines = await db
    .select({
      id: stockTransferItems.id,
      sku: products.sku,
      productName: products.productName,
      batchNumber: inventoryBatches.batchNumber,
      expirationDate: inventoryBatches.expirationDate,
      quantityRequested: stockTransferItems.quantityRequested,
      quantityShipped: stockTransferItems.quantityShipped,
      quantityReceived: stockTransferItems.quantityReceived,
    })
    .from(stockTransferItems)
    .innerJoin(products, eq(products.id, stockTransferItems.productId))
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, stockTransferItems.sourceInventoryBatchId))
    .where(eq(stockTransferItems.stockTransferId, id))
    .orderBy(
      asc(products.productName),
      asc(inventoryBatches.batchNumber),
      asc(stockTransferItems.id),
    );

  return {
    transfer,
    lines: lines.map((line) => {
      return {
        ...line,
        expirationDate: toDateString(line.expirationDate),
        quantityRequested: toScale(line.quantityRequested, 3),
        quantityShipped: toScale(line.quantityShipped, 3),
        quantityReceived: toScale(line.quantityReceived, 3),
      };
    }),
  };
}

/** Transfers newest first that involve the user's branch (all branches with the all-branch scope). */
export async function listTransfers(user, { status, page = 1 } = {}) {
  const conditions = [];

  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    conditions.push(
      sql`(${stockTransfers.sourceBranchId} = ${user.branchId ?? ""} OR ${stockTransfers.destinationBranchId} = ${user.branchId ?? ""})`,
    );
  }

  if (TRANSFER_STATUSES.includes(status)) {
    conditions.push(eq(stockTransfers.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageNumber = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
  const [{ n }] = await db.select({ n: count() }).from(stockTransfers).where(where);
  const rows = await headerQuery(db)
    .where(where)
    .orderBy(desc(stockTransfers.createdAt), desc(stockTransfers.transferNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return { rows, total: n, page: pageNumber, pageSize: PAGE_SIZE };
}

/** The other branches a request can go to. */
export async function listTransferSources(user) {
  const rows = await db
    .select({ id: branches.id, code: branches.code, name: branches.name })
    .from(branches)
    .orderBy(asc(branches.code));

  return rows.filter((row) => {
    return row.id !== user.branchId;
  });
}

/** Batches of another branch that can be requested now (active, unexpired, in stock). */
export async function listTransferableBatches(user, sourceBranchId, { now = new Date() } = {}) {
  if (!isUuid(sourceBranchId) || sourceBranchId === user.branchId) {
    return [];
  }

  const rows = await db
    .select({
      id: inventoryBatches.id,
      batchNumber: inventoryBatches.batchNumber,
      sku: products.sku,
      productName: products.productName,
      quantityAvailable: inventoryBatches.quantityAvailable,
      expirationDate: inventoryBatches.expirationDate,
    })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(
      and(
        eq(inventoryBatches.branchId, sourceBranchId),
        eq(inventoryBatches.status, "ACTIVE"),
        sql`${inventoryBatches.quantityAvailable} > 0`,
        sql`(${inventoryBatches.expirationDate} IS NULL OR ${inventoryBatches.expirationDate} >= ${businessDate(now)})`,
      ),
    )
    .orderBy(
      asc(products.productName),
      asc(inventoryBatches.expirationDate),
      asc(inventoryBatches.batchNumber),
    )
    .limit(BATCH_CHOICES);

  return rows.map((row) => {
    return {
      id: row.id,
      batchNumber: row.batchNumber,
      label: `${row.productName} (${row.sku}) - lot ${row.batchNumber}, ${toScale(row.quantityAvailable, 3)} available`,
    };
  });
}
