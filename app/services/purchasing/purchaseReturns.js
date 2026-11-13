// Supplier purchase returns. A return is drafted against batches of the actor's branch (the batch's
// unit cost is snapshotted), submitted, approved by a different person and then posted, which takes the
// quantity off each batch and writes a PURCHASE_RETURN movement. Every step locks the return and
// re-checks its state; posting also re-checks each batch still holds the quantity, and locks inventory
// rows then batches the way checkout does. Supplier credit is reconciled outside the system.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { products } from "../../models/products.js";
import { purchaseReturnItems } from "../../models/purchase-return-items.js";
import { purchaseReturns } from "../../models/purchase-returns.js";
import { suppliers } from "../../models/suppliers.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { add, cmp, mul, sub, sum, toScale } from "../support/decimal.js";
import { isDeadlock } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";
import { businessDate } from "../support/time.js";
import { nextDocumentNumber } from "./numbers.js";

const MAX_LINES = 100;
const MAX_REASON = 500;
const PAGE_SIZE = 25;
const BATCH_CHOICES = 500;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;
// stock being sent back is often exactly the stock that cannot be sold
const RETURNABLE = ["ACTIVE", "QUARANTINED", "RECALLED", "EXPIRED"];

export const PURCHASE_RETURN_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "POSTED",
  "REJECTED",
  "CANCELLED",
];

const notFound = () => {
  return new HttpError(404, "not_found", "Purchase return not found");
};

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

const isBlank = (value) => {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
};

// ---- drafting ----

async function checkDraft(tx, user, input) {
  const errors = [];
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  const supplierId = input?.supplierId;
  const [supplier] = isUuid(supplierId)
    ? await tx.select().from(suppliers).where(eq(suppliers.id, supplierId))
    : [];

  if (!supplier) {
    errors.push({ path: "supplierId", message: "Choose the supplier it goes back to" });
  }

  if (reason === "" || reason.length > MAX_REASON) {
    errors.push({ path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` });
  }

  const rawLines = Array.isArray(input?.lines) ? input.lines : [];
  const filled = rawLines
    .map((line, index) => {
      return { line, index };
    })
    .filter(({ line }) => {
      return !(isBlank(line?.inventoryBatchId) && isBlank(line?.quantity));
    });

  if (filled.length === 0 || filled.length > MAX_LINES || rawLines.length > MAX_LINES * 2) {
    errors.push({ path: "lines", message: `Return 1 to ${MAX_LINES} batches` });
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
      const batch = isUuid(line.inventoryBatchId) ? byId.get(line.inventoryBatchId) : undefined;
      const text = typeof line.quantity === "string" ? line.quantity.trim() : "";

      if (!batch || batch.branchId !== user.branchId) {
        errors.push({ path: `lines.${index}.inventoryBatchId`, message: "Choose a batch" });
        continue;
      }

      if (seen.has(batch.id)) {
        errors.push({
          path: `lines.${index}.inventoryBatchId`,
          message: "This batch is already on the return",
        });
        continue;
      }

      seen.add(batch.id);

      if (!RETURNABLE.includes(batch.status)) {
        errors.push({
          path: `lines.${index}.inventoryBatchId`,
          message: `A ${batch.status.toLowerCase()} batch has nothing to return`,
        });
      } else if (!QUANTITY.test(text) || cmp(text, "0") <= 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: "Enter a quantity above 0, up to 3 decimals",
        });
      } else if (cmp(text, batch.quantityAvailable) > 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: `Only ${toScale(batch.quantityAvailable, 3)} is in this batch`,
        });
      } else {
        rows.push({ batch, quantity: toScale(text, 3) });
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return { supplier, reason, rows };
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

/** A new DRAFT return to a supplier from the actor's branch. Returns { id, returnNumber }. */
export async function createPurchaseReturn(user, input, { now = new Date(), meta = {} } = {}) {
  if (!can(user, PERMISSIONS.PURCHASING_MANAGE)) {
    throw forbidden("You do not have permission to return stock to suppliers");
  }

  if (!user.branchId) {
    throw forbidden("Returns belong to a branch, and this account has none");
  }

  return await db.transaction(
    async (tx) => {
      const draft = await checkDraft(tx, user, input);
      const id = randomUUID();
      const returnNumber = await nextDocumentNumber(tx, "PRT", user.branchCode, businessDate(now));

      await tx.insert(purchaseReturns).values({
        id,
        returnNumber,
        branchId: user.branchId,
        supplierId: draft.supplier.id,
        status: "DRAFT",
        reason: draft.reason,
        createdBy: user.id,
      });
      await tx.insert(purchaseReturnItems).values(
        draft.rows.map(({ batch, quantity }) => {
          return {
            id: randomUUID(),
            purchaseReturnId: id,
            inventoryBatchId: batch.id,
            quantity,
            unitCost: batch.unitCost,
          };
        }),
      );
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "PURCHASE_RETURN_CREATED",
        entityType: "purchase_return",
        entityId: id,
        newValues: { returnNumber, supplier: draft.supplier.name, lines: draft.rows.length },
        reason: draft.reason,
        ...meta,
      });

      return { id, returnNumber };
    },
    { isolationLevel: "read committed" },
  );
}

// ---- steps ----

async function lockReturn(tx, user, id, from, verb) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await tx
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.id, id))
    .for("update");

  if (!row || row.branchId !== user.branchId) {
    throw notFound();
  }

  if (!from.includes(row.status)) {
    throw new HttpError(
      409,
      "return_state",
      `A ${row.status.toLowerCase().replaceAll("_", " ")} return cannot be ${verb}`,
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
      const row = await lockReturn(tx, user, id, rule.from, rule.verb);

      if (rule.distinct && row.createdBy === user.id) {
        throw forbidden("A different person must approve a return");
      }

      await tx
        .update(purchaseReturns)
        .set({ status: rule.to, ...rule.set?.(user, now) })
        .where(eq(purchaseReturns.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "purchase_return",
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
    from: ["DRAFT"],
    to: "PENDING_APPROVAL",
    verb: "submitted",
    action: "PURCHASE_RETURN_SUBMITTED",
    needs: [PERMISSIONS.PURCHASING_MANAGE],
  },
  approve: {
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    verb: "approved",
    action: "PURCHASE_RETURN_APPROVED",
    needs: [PERMISSIONS.PURCHASING_APPROVE],
    distinct: true,
    set: (user, now) => {
      return { approvedBy: user.id, approvedAt: now };
    },
  },
  reject: {
    from: ["PENDING_APPROVAL"],
    to: "REJECTED",
    verb: "rejected",
    action: "PURCHASE_RETURN_REJECTED",
    needs: [PERMISSIONS.PURCHASING_APPROVE],
    reason: "required",
  },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
    to: "CANCELLED",
    verb: "cancelled",
    action: "PURCHASE_RETURN_CANCELLED",
    needs: [PERMISSIONS.PURCHASING_MANAGE, PERMISSIONS.PURCHASING_APPROVE],
    reason: "required",
  },
};

export const submitPurchaseReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.submit, options);
};
export const approvePurchaseReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.approve, options);
};
export const rejectPurchaseReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.reject, options);
};
export const cancelPurchaseReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.cancel, options);
};

const stale = (message) => {
  return new HttpError(409, "return_stock", message);
};

/**
 * APPROVED → POSTED. Locks inventory rows (branch and product order, like checkout) then batches (id
 * order), refuses if any batch cannot give the quantity any more, then takes it off each batch, writes
 * a PURCHASE_RETURN movement per line and lowers on-hand. A deadlock with a sale is retried.
 */
export async function postPurchaseReturn(user, id, input, options = {}) {
  if (!can(user, PERMISSIONS.PURCHASING_APPROVE)) {
    throw forbidden("You do not have permission for this step");
  }

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
      const header = await lockReturn(tx, user, id, ["APPROVED"], "posted");
      const items = await tx
        .select()
        .from(purchaseReturnItems)
        .where(eq(purchaseReturnItems.purchaseReturnId, id))
        .orderBy(asc(purchaseReturnItems.inventoryBatchId));
      const batchIds = items.map((item) => {
        return item.inventoryBatchId;
      });
      const probes = await tx
        .select({ productId: inventoryBatches.productId })
        .from(inventoryBatches)
        .where(inArray(inventoryBatches.id, batchIds));
      const stocks = await tx
        .select()
        .from(inventories)
        .where(
          and(
            eq(inventories.branchId, header.branchId),
            inArray(
              inventories.productId,
              probes.map((probe) => {
                return probe.productId;
              }),
            ),
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
      const taken = new Map();

      for (const item of items) {
        const batch = batchById.get(item.inventoryBatchId);

        if (
          !batch ||
          !RETURNABLE.includes(batch.status) ||
          cmp(batch.quantityAvailable, item.quantity) < 0
        ) {
          throw stale(
            `Batch ${batch?.batchNumber ?? "(removed)"} no longer holds ${toScale(item.quantity, 3)}. Cancel this return and draft it again.`,
          );
        }
      }

      for (const item of items) {
        const batch = batchById.get(item.inventoryBatchId);
        const after = toScale(sub(batch.quantityAvailable, item.quantity), 3);

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
          movementType: "PURCHASE_RETURN",
          referenceType: "purchase_return",
          referenceId: id,
          quantityChange: sub("0", toScale(item.quantity, 3)),
          quantityBefore: toScale(batch.quantityAvailable, 3),
          quantityAfter: after,
          unitCost: item.unitCost,
          reason: `Returned to supplier on ${header.returnNumber}`,
          performedBy: user.id,
          createdAt: now,
        });
        taken.set(batch.inventoryId, add(taken.get(batch.inventoryId) ?? "0", item.quantity));
      }

      for (const [inventoryId, quantity] of taken) {
        const next = sub(stockById.get(inventoryId).quantityOnHand, quantity);

        if (cmp(next, "0") < 0) {
          throw stale(
            "The on-hand total no longer covers this return. Cancel it and draft it again.",
          );
        }

        await tx
          .update(inventories)
          .set({ quantityOnHand: toScale(next, 3) })
          .where(eq(inventories.id, inventoryId));
      }

      await tx
        .update(purchaseReturns)
        .set({ status: "POSTED", postedAt: now })
        .where(eq(purchaseReturns.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "PURCHASE_RETURN_POSTED",
        entityType: "purchase_return",
        entityId: id,
        oldValues: { status: "APPROVED" },
        newValues: { status: "POSTED", lines: items.length },
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
  id: purchaseReturns.id,
  returnNumber: purchaseReturns.returnNumber,
  branchId: purchaseReturns.branchId,
  branchName: branches.name,
  supplierName: suppliers.name,
  status: purchaseReturns.status,
  reason: purchaseReturns.reason,
  createdBy: purchaseReturns.createdBy,
  createdByName: users.name,
  approvedAt: purchaseReturns.approvedAt,
  postedAt: purchaseReturns.postedAt,
  createdAt: purchaseReturns.createdAt,
};

function headerQuery(executor) {
  return executor
    .select(headerSelect)
    .from(purchaseReturns)
    .innerJoin(branches, eq(branches.id, purchaseReturns.branchId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseReturns.supplierId))
    .innerJoin(users, eq(users.id, purchaseReturns.createdBy));
}

/** One return with its lines and total value. Other branches are a 404 unless all-branch scope. */
export async function getPurchaseReturn(user, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [header] = await headerQuery(db).where(eq(purchaseReturns.id, id));

  if (!header || !sees(user, header.branchId)) {
    throw notFound();
  }

  const lines = await db
    .select({
      id: purchaseReturnItems.id,
      sku: products.sku,
      productName: products.productName,
      batchNumber: inventoryBatches.batchNumber,
      batchStatus: inventoryBatches.status,
      quantity: purchaseReturnItems.quantity,
      unitCost: purchaseReturnItems.unitCost,
    })
    .from(purchaseReturnItems)
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, purchaseReturnItems.inventoryBatchId))
    .innerJoin(products, eq(products.id, inventoryBatches.productId))
    .where(eq(purchaseReturnItems.purchaseReturnId, id))
    .orderBy(
      asc(products.productName),
      asc(inventoryBatches.batchNumber),
      asc(purchaseReturnItems.id),
    );
  const shaped = lines.map((line) => {
    return {
      ...line,
      quantity: toScale(line.quantity, 3),
      unitCost: toScale(line.unitCost, 4),
      value: toScale(mul(line.quantity, line.unitCost), 2),
    };
  });

  return {
    purchaseReturn: {
      ...header,
      totalValue: toScale(
        sum(
          shaped.map((line) => {
            return line.value;
          }),
        ),
        2,
      ),
    },
    lines: shaped,
  };
}

/** Returns newest first, in the user's branch (all branches with the all-branch scope). */
export async function listPurchaseReturns(user, { status, page = 1 } = {}) {
  const conditions = [];

  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    conditions.push(eq(purchaseReturns.branchId, user.branchId ?? ""));
  }

  if (PURCHASE_RETURN_STATUSES.includes(status)) {
    conditions.push(eq(purchaseReturns.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const lastPage = (total) => {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  };
  const [{ n }] = await db.select({ n: count() }).from(purchaseReturns).where(where);
  const pageNumber = Number.isSafeInteger(page) && page > 0 ? Math.min(page, lastPage(n)) : 1;
  const rows = await headerQuery(db)
    .where(where)
    .orderBy(desc(purchaseReturns.createdAt), desc(purchaseReturns.returnNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return { rows, total: n, page: pageNumber, pageSize: PAGE_SIZE };
}

/** Batches of the user's branch that can be returned, by product then expiry. */
export async function listReturnableBatches(user) {
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
        inArray(inventoryBatches.status, RETURNABLE),
      ),
    )
    .orderBy(
      asc(products.productName),
      asc(inventoryBatches.expirationDate),
      asc(inventoryBatches.batchNumber),
    )
    .limit(BATCH_CHOICES);

  return rows
    .filter((row) => {
      return cmp(row.quantityAvailable, "0") > 0;
    })
    .map((row) => {
      return {
        id: row.id,
        batchNumber: row.batchNumber,
        label: `${row.productName} (${row.sku}) - lot ${row.batchNumber}, ${toScale(row.quantityAvailable, 3)} on hand, ${row.status.toLowerCase()}`,
      };
    });
}

/** Active suppliers for the form, by name. */
export async function listReturnSuppliers() {
  return await db
    .select({ id: suppliers.id, code: suppliers.code, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.isActive, true))
    .orderBy(asc(suppliers.name));
}
