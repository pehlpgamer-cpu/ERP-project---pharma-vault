// Stock counts and adjustments. A count is drafted against batches (snapshotting what the books say),
// submitted, approved by a different person and then posted, which sets each batch to the counted
// quantity and writes a STOCK_ADJUSTMENT movement. Every step locks the document and re-checks its
// state, and posting also re-checks that each batch still holds the snapshotted quantity, so a count
// taken before a sale cannot overwrite the sale. Actions stay in the actor's own branch.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { inventories } from "../../models/inventories.js";
import { inventoryAdjustmentItems } from "../../models/inventory-adjustment-items.js";
import { inventoryAdjustments } from "../../models/inventory-adjustments.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { products } from "../../models/products.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { add, cmp, sub, toScale } from "../support/decimal.js";
import { isDeadlock } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";
import { businessDate } from "../support/time.js";
import { nextDocumentNumber } from "../purchasing/numbers.js";

const MAX_LINES = 100;
const MAX_REASON = 500;
const PAGE_SIZE = 25;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;
const COUNTABLE = ["ACTIVE", "QUARANTINED"];

export const ADJUSTMENT_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "POSTED",
  "CANCELLED",
];

const notFound = () => {
  return new HttpError(404, "not_found", "Stock adjustment not found");
};

const wrongState = (message) => {
  return new HttpError(409, "adjustment_state", message);
};

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

// ---- checking a draft ----

const isBlank = (value) => {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
};

async function checkDraft(executor, user, input) {
  const errors = [];
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  const rawLines = Array.isArray(input?.lines) ? input.lines : [];
  const filled = rawLines
    .map((line, index) => {
      return { line, index };
    })
    .filter(({ line }) => {
      return !(isBlank(line?.inventoryBatchId) && isBlank(line?.countedQuantity));
    });

  if (reason === "" || reason.length > MAX_REASON) {
    errors.push({ path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` });
  }

  if (filled.length === 0 || filled.length > MAX_LINES || rawLines.length > MAX_LINES * 2) {
    errors.push({ path: "lines", message: `Count 1 to ${MAX_LINES} batches` });
  }

  const wanted = filled
    .slice(0, MAX_LINES)
    .map(({ line }) => {
      return line.inventoryBatchId;
    })
    .filter(isUuid);
  const found =
    wanted.length === 0
      ? []
      : await executor.select().from(inventoryBatches).where(inArray(inventoryBatches.id, wanted));
  const byId = new Map(
    found.map((batch) => {
      return [batch.id, batch];
    }),
  );
  const seen = new Set();
  const lines = [];

  if (filled.length <= MAX_LINES && rawLines.length <= MAX_LINES * 2) {
    for (const { line, index } of filled) {
      const batch = isUuid(line.inventoryBatchId) ? byId.get(line.inventoryBatchId) : undefined;
      const counted = typeof line.countedQuantity === "string" ? line.countedQuantity.trim() : "";
      const row = { batch };

      if (!batch || batch.branchId !== user.branchId) {
        errors.push({ path: `lines.${index}.inventoryBatchId`, message: "Choose a batch" });
        row.batch = undefined;
      } else if (!COUNTABLE.includes(batch.status)) {
        errors.push({
          path: `lines.${index}.inventoryBatchId`,
          message: `A ${batch.status.toLowerCase()} batch cannot be counted`,
        });
      } else if (seen.has(batch.id)) {
        errors.push({
          path: `lines.${index}.inventoryBatchId`,
          message: "This batch is already on the count",
        });
      }

      if (batch) {
        seen.add(batch.id);
      }

      if (!QUANTITY.test(counted)) {
        errors.push({
          path: `lines.${index}.countedQuantity`,
          message: "Enter the counted quantity, 0 or more, up to 3 decimals",
        });
      } else if (batch && cmp(counted, batch.quantityReceived) > 0) {
        errors.push({
          path: `lines.${index}.countedQuantity`,
          message: `Cannot exceed the ${toScale(batch.quantityReceived, 3)} received into this batch`,
        });
      } else {
        row.counted = toScale(counted, 3);
      }

      lines.push(row);
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return {
    reason,
    rows: lines.map(({ batch, counted }) => {
      const before = toScale(batch.quantityAvailable, 3);

      return {
        batchId: batch.id,
        quantityBefore: before,
        countedQuantity: counted,
        quantityChange: toScale(sub(counted, before), 3),
      };
    }),
  };
}

function cleanReason(input, required) {
  const text = typeof input?.reason === "string" ? input.reason.trim() : "";

  if ((required && text === "") || text.length > MAX_REASON) {
    throw new ValidationError([
      { path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` },
    ]);
  }

  return text === "" ? null : text;
}

// ---- writing ----

/** A new DRAFT count in the actor's branch. Returns { id, adjustmentNumber }. */
export async function createAdjustment(user, input, { now = new Date(), meta = {} } = {}) {
  if (!can(user, PERMISSIONS.INVENTORY_ADJUST)) {
    throw forbidden("You do not have permission to count or adjust stock");
  }

  if (!user.branchId) {
    throw forbidden("Stock counts belong to a branch, and this account has none");
  }

  return await db.transaction(
    async (tx) => {
      const draft = await checkDraft(tx, user, input);
      const id = randomUUID();
      const adjustmentNumber = await nextDocumentNumber(
        tx,
        "ADJ",
        user.branchCode,
        businessDate(now),
      );

      await tx.insert(inventoryAdjustments).values({
        id,
        branchId: user.branchId,
        adjustmentNumber,
        status: "DRAFT",
        reason: draft.reason,
        createdBy: user.id,
      });
      await tx.insert(inventoryAdjustmentItems).values(
        draft.rows.map((row) => {
          return {
            id: randomUUID(),
            inventoryAdjustmentId: id,
            inventoryBatchId: row.batchId,
            quantityBefore: row.quantityBefore,
            countedQuantity: row.countedQuantity,
            quantityChange: row.quantityChange,
          };
        }),
      );
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "ADJUSTMENT_CREATED",
        entityType: "inventory_adjustment",
        entityId: id,
        newValues: { adjustmentNumber, lines: draft.rows.length },
        reason: draft.reason,
        ...meta,
      });

      return { id, adjustmentNumber };
    },
    { isolationLevel: "read committed" },
  );
}

/** Locks the document in the actor's branch and checks it is in one of the `from` states. */
async function lockAdjustment(tx, user, id, from, verb) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [adjustment] = await tx
    .select()
    .from(inventoryAdjustments)
    .where(eq(inventoryAdjustments.id, id))
    .for("update");

  if (!adjustment || adjustment.branchId !== user.branchId) {
    throw notFound();
  }

  if (!from.includes(adjustment.status)) {
    throw wrongState(
      `A ${adjustment.status.toLowerCase().replaceAll("_", " ")} adjustment cannot be ${verb}`,
    );
  }

  return adjustment;
}

async function move(user, id, input, rule, { now = new Date(), meta = {} } = {}) {
  const reason = cleanReason(input, rule.reason === "required");

  if (!can(user, rule.needs)) {
    throw forbidden("You do not have permission for this step");
  }

  return await db.transaction(
    async (tx) => {
      const adjustment = await lockAdjustment(tx, user, id, rule.from, rule.verb);

      if (rule.distinct && adjustment.createdBy === user.id) {
        throw forbidden("A different person must approve a count");
      }

      await tx
        .update(inventoryAdjustments)
        .set({ status: rule.to, ...rule.set?.(user, now) })
        .where(eq(inventoryAdjustments.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "inventory_adjustment",
        entityId: id,
        oldValues: { status: adjustment.status },
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
    from: ["DRAFT"],
    to: "PENDING_APPROVAL",
    verb: "submitted",
    action: "ADJUSTMENT_SUBMITTED",
    needs: PERMISSIONS.INVENTORY_ADJUST,
  },
  approve: {
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    verb: "approved",
    action: "ADJUSTMENT_APPROVED",
    needs: PERMISSIONS.INVENTORY_APPROVE,
    distinct: true,
    set: (user, now) => {
      return { approvedBy: user.id, approvedAt: now };
    },
  },
  reject: {
    from: ["PENDING_APPROVAL"],
    to: "REJECTED",
    verb: "rejected",
    action: "ADJUSTMENT_REJECTED",
    needs: PERMISSIONS.INVENTORY_APPROVE,
    reason: "required",
  },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
    to: "CANCELLED",
    verb: "cancelled",
    action: "ADJUSTMENT_CANCELLED",
    needs: PERMISSIONS.INVENTORY_ADJUST,
    reason: "required",
  },
};

export const submitAdjustment = (user, id, input, options) => {
  return move(user, id, input, RULES.submit, options);
};
export const approveAdjustment = (user, id, input, options) => {
  return move(user, id, input, RULES.approve, options);
};
export const rejectAdjustment = (user, id, input, options) => {
  return move(user, id, input, RULES.reject, options);
};
export const cancelAdjustment = (user, id, input, options) => {
  return move(user, id, input, RULES.cancel, options);
};

const stale = (batchNumber) => {
  return new HttpError(
    409,
    "count_stale",
    `Batch ${batchNumber} changed since it was counted. Cancel this count and count it again.`,
  );
};

/**
 * APPROVED → POSTED. Locks inventory rows, then batches (both in id order, after the document: the
 * order checkout locks them: by product id), refuses if any batch moved since the count, then sets each
 * counted batch, writes one movement per changed line and adjusts the on-hand totals.
 */
export async function postAdjustment(user, id, input, options = {}) {
  if (!can(user, PERMISSIONS.INVENTORY_APPROVE)) {
    throw forbidden("You do not have permission for this step");
  }

  // a sale locking the same rows can win a deadlock; nothing was written, so run it again
  for (let attempt = 1; ; attempt++) {
    try {
      return await postOnce(user, id, options);
    } catch (error) {
      if (!isDeadlock(error) || attempt >= 3) {
        throw error;
      }
    }
  }
}

async function postOnce(user, id, { now = new Date(), meta = {} }) {
  return await db.transaction(
    async (tx) => {
      const adjustment = await lockAdjustment(tx, user, id, ["APPROVED"], "posted");
      const items = await tx
        .select()
        .from(inventoryAdjustmentItems)
        .where(eq(inventoryAdjustmentItems.inventoryAdjustmentId, id))
        .orderBy(asc(inventoryAdjustmentItems.inventoryBatchId));
      const batchIds = items.map((item) => {
        return item.inventoryBatchId;
      });
      const probes = await tx
        .select({ inventoryId: inventoryBatches.inventoryId })
        .from(inventoryBatches)
        .where(inArray(inventoryBatches.id, batchIds));
      const inventoryIds = [
        ...new Set(
          probes.map((probe) => {
            return probe.inventoryId;
          }),
        ),
      ].sort();
      const stocks = await tx
        .select()
        .from(inventories)
        .where(inArray(inventories.id, inventoryIds))
        .orderBy(asc(inventories.productId))
        .for("update");
      const batches = await tx
        .select()
        .from(inventoryBatches)
        .where(inArray(inventoryBatches.id, batchIds))
        .orderBy(asc(inventoryBatches.id))
        .for("update");
      const batchById = new Map(
        batches.map((batch) => {
          return [batch.id, batch];
        }),
      );
      const stockById = new Map(
        stocks.map((stock) => {
          return [stock.id, stock];
        }),
      );
      const deltas = new Map();
      let changed = 0;

      for (const item of items) {
        const batch = batchById.get(item.inventoryBatchId);

        if (
          !batch ||
          !COUNTABLE.includes(batch.status) ||
          cmp(batch.quantityAvailable, item.quantityBefore) !== 0
        ) {
          throw stale(batch?.batchNumber ?? "(removed)");
        }
      }

      for (const item of items) {
        if (cmp(item.quantityChange, "0") === 0) {
          continue;
        }

        const batch = batchById.get(item.inventoryBatchId);
        const counted = toScale(item.countedQuantity, 3);

        changed += 1;
        deltas.set(
          batch.inventoryId,
          add(deltas.get(batch.inventoryId) ?? "0", item.quantityChange),
        );
        await tx
          .update(inventoryBatches)
          .set({
            quantityAvailable: counted,
            // only a batch that was on sale becomes depleted; a quarantined one stays quarantined
            status:
              cmp(counted, "0") === 0 && batch.status === "ACTIVE" ? "DEPLETED" : batch.status,
          })
          .where(eq(inventoryBatches.id, batch.id));
        await tx.insert(inventoryMovements).values({
          id: randomUUID(),
          branchId: batch.branchId,
          productId: batch.productId,
          inventoryBatchId: batch.id,
          movementType: "STOCK_ADJUSTMENT",
          referenceType: "inventory_adjustment",
          referenceId: id,
          quantityChange: toScale(item.quantityChange, 3),
          quantityBefore: toScale(item.quantityBefore, 3),
          quantityAfter: counted,
          unitCost: batch.unitCost,
          reason: adjustment.reason,
          performedBy: user.id,
          createdAt: now,
        });
      }

      for (const [inventoryId, delta] of deltas) {
        const next = add(stockById.get(inventoryId).quantityOnHand, delta);

        if (cmp(next, "0") < 0) {
          throw new HttpError(
            409,
            "count_stale",
            "The on-hand total no longer covers this count. Cancel it and count again.",
          );
        }

        await tx
          .update(inventories)
          .set({ quantityOnHand: toScale(next, 3) })
          .where(eq(inventories.id, inventoryId));
      }

      await tx
        .update(inventoryAdjustments)
        .set({ status: "POSTED", postedAt: now })
        .where(eq(inventoryAdjustments.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "ADJUSTMENT_POSTED",
        entityType: "inventory_adjustment",
        entityId: id,
        oldValues: { status: "APPROVED" },
        newValues: { status: "POSTED", linesChanged: changed },
        ...meta,
      });

      return { id, status: "POSTED" };
    },
    { isolationLevel: "read committed" },
  );
}

// ---- reading ----

const sees = (user, branchId) => {
  return branchId === user.branchId || can(user, PERMISSIONS.SALES_VIEW_ALL);
};

const headerSelect = {
  id: inventoryAdjustments.id,
  adjustmentNumber: inventoryAdjustments.adjustmentNumber,
  branchId: inventoryAdjustments.branchId,
  branchName: branches.name,
  status: inventoryAdjustments.status,
  reason: inventoryAdjustments.reason,
  createdBy: inventoryAdjustments.createdBy,
  createdByName: users.name,
  approvedBy: inventoryAdjustments.approvedBy,
  approvedAt: inventoryAdjustments.approvedAt,
  postedAt: inventoryAdjustments.postedAt,
  createdAt: inventoryAdjustments.createdAt,
};

/** One count with its lines. Other branches are a 404 unless the user has the all-branch scope. */
export async function getAdjustment(user, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [adjustment] = await db
    .select(headerSelect)
    .from(inventoryAdjustments)
    .innerJoin(branches, eq(branches.id, inventoryAdjustments.branchId))
    .innerJoin(users, eq(users.id, inventoryAdjustments.createdBy))
    .where(eq(inventoryAdjustments.id, id));

  if (!adjustment || !sees(user, adjustment.branchId)) {
    throw notFound();
  }

  const lines = await db
    .select({
      id: inventoryAdjustmentItems.id,
      inventoryBatchId: inventoryAdjustmentItems.inventoryBatchId,
      batchNumber: inventoryBatches.batchNumber,
      expirationDate: inventoryBatches.expirationDate,
      batchStatus: inventoryBatches.status,
      sku: products.sku,
      productName: products.productName,
      quantityBefore: inventoryAdjustmentItems.quantityBefore,
      countedQuantity: inventoryAdjustmentItems.countedQuantity,
      quantityChange: inventoryAdjustmentItems.quantityChange,
    })
    .from(inventoryAdjustmentItems)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, inventoryAdjustmentItems.inventoryBatchId))
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(eq(inventoryAdjustmentItems.inventoryAdjustmentId, id))
    .orderBy(
      asc(products.productName),
      asc(inventoryBatches.batchNumber),
      asc(inventoryAdjustmentItems.id),
    );

  return { adjustment, lines };
}

/** Counts newest first, in the user's branch (all branches with the all-branch scope). */
export async function listAdjustments(user, { status, page = 1 } = {}) {
  const conditions = [];

  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    conditions.push(eq(inventoryAdjustments.branchId, user.branchId ?? ""));
  }

  if (ADJUSTMENT_STATUSES.includes(status)) {
    conditions.push(eq(inventoryAdjustments.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageNumber = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
  const [{ n }] = await db.select({ n: count() }).from(inventoryAdjustments).where(where);
  const rows = await db
    .select(headerSelect)
    .from(inventoryAdjustments)
    .innerJoin(branches, eq(branches.id, inventoryAdjustments.branchId))
    .innerJoin(users, eq(users.id, inventoryAdjustments.createdBy))
    .where(where)
    .orderBy(desc(inventoryAdjustments.createdAt), desc(inventoryAdjustments.adjustmentNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return { rows, total: n, page: pageNumber, pageSize: PAGE_SIZE };
}

const BATCH_CHOICES = 500;

/** Countable batches in the user's branch for the count form, by product then expiry. */
export async function listCountableBatches(user) {
  const rows = await db
    .select({
      id: inventoryBatches.id,
      batchNumber: inventoryBatches.batchNumber,
      sku: products.sku,
      productName: products.productName,
      quantityAvailable: inventoryBatches.quantityAvailable,
      status: inventoryBatches.status,
    })
    .from(inventoryBatches)
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(
      and(
        eq(inventoryBatches.branchId, user.branchId ?? ""),
        inArray(inventoryBatches.status, COUNTABLE),
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
      label: `${row.productName} (${row.sku}) - lot ${row.batchNumber}, ${toScale(row.quantityAvailable, 3)} on record`,
    };
  });
}
