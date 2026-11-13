// Sales returns and refunds. A return is drafted against the batch pieces a sale was filled from,
// submitted, approved by a different person and then processed: processing puts restockable units
// back on their original batch, pays the refund out the way the money came in, and moves the sale to
// PARTIALLY_REFUNDED or REFUNDED. Drafting locks the sale row, so two returns cannot claim the same
// units; every later step locks the return and re-checks its state. Actions stay in the actor's branch.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { cashRegisterSessions } from "../../models/cash-register-sessions.js";
import { cashTransactions } from "../../models/cash-transactions.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { refunds } from "../../models/refunds.js";
import { saleItemBatches } from "../../models/sale-item-batches.js";
import { saleItems } from "../../models/sale-items.js";
import { salePayments } from "../../models/sale-payments.js";
import { sales } from "../../models/sales.js";
import { salesReturnItems } from "../../models/sales-return-items.js";
import { salesReturns } from "../../models/sales-returns.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { nextDocumentNumber } from "../purchasing/numbers.js";
import { add, cmp, div, mul, sub, sum, toScale } from "../support/decimal.js";
import { isDeadlock } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";
import { addDays, businessDate, toDateString } from "../support/time.js";

const MAX_LINES = 100;
const MAX_REASON = 500;
const MAX_REFERENCE = 150;
const PAGE_SIZE = 25;
const RETURN_WINDOW_DAYS = 30;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;

export const RETURN_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "PROCESSED",
  "REJECTED",
  "CANCELLED",
];
export const DISPOSITIONS = ["RESTOCK", "QUARANTINE", "DAMAGED", "DISPOSE"];
export const REFUND_METHODS = ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"];

// returns whose units are spoken for: they count against what a sale line can still give back
const CLAIMING = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PROCESSED"];
const RETURNABLE_SALES = ["COMPLETED", "PARTIALLY_REFUNDED"];
const RESTOCKABLE = ["ACTIVE", "DEPLETED"];

const notFound = () => {
  return new HttpError(404, "not_found", "Return not found");
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

// ---- what a sale can still give back ----

const pieceKey = (saleItemId, batchId) => {
  return `${saleItemId}:${batchId}`;
};

/** The sale's batch pieces with their lines' totals, and what returns have already claimed. */
async function loadPieces(executor, saleId) {
  const pieces = await executor
    .select({
      id: saleItemBatches.id,
      saleItemId: saleItemBatches.saleItemId,
      inventoryBatchId: saleItemBatches.inventoryBatchId,
      sold: saleItemBatches.quantity,
      productName: saleItems.productNameSnapshot,
      itemBaseQuantity: saleItems.baseQuantity,
      itemTotal: saleItems.totalAmount,
      batchNumber: inventoryBatches.batchNumber,
      batchStatus: inventoryBatches.status,
      expirationDate: inventoryBatches.expirationDate,
    })
    .from(saleItemBatches)
    .innerJoin(saleItems, eq(saleItems.id, saleItemBatches.saleItemId))
    .innerJoin(inventoryBatches, eq(inventoryBatches.id, saleItemBatches.inventoryBatchId))
    .where(eq(saleItems.saleId, saleId))
    .orderBy(
      asc(saleItems.productNameSnapshot),
      asc(inventoryBatches.batchNumber),
      asc(saleItemBatches.id),
    );
  const claimed = await executor
    .select({
      saleItemId: salesReturnItems.saleItemId,
      inventoryBatchId: salesReturnItems.inventoryBatchId,
      quantity: salesReturnItems.quantity,
      refundAmount: salesReturnItems.refundAmount,
    })
    .from(salesReturnItems)
    .innerJoin(salesReturns, eq(salesReturns.id, salesReturnItems.salesReturnId))
    .where(and(eq(salesReturns.saleId, saleId), inArray(salesReturns.status, CLAIMING)));
  const byPiece = new Map();
  const byItem = new Map();

  for (const row of claimed) {
    const key = pieceKey(row.saleItemId, row.inventoryBatchId);
    const item = byItem.get(row.saleItemId) ?? { quantity: "0", refund: "0" };

    byPiece.set(key, add(byPiece.get(key) ?? "0", row.quantity));
    byItem.set(row.saleItemId, {
      quantity: add(item.quantity, row.quantity),
      refund: add(item.refund, row.refundAmount),
    });
  }

  return { pieces, byPiece, byItem };
}

const soldMessage = (sale, today) => {
  if (!RETURNABLE_SALES.includes(sale.status)) {
    return {
      code: "return_sale_state",
      message: `A ${sale.status.toLowerCase().replaceAll("_", " ")} sale cannot take a return`,
    };
  }

  if (addDays(businessDate(sale.transactionDate), RETURN_WINDOW_DAYS) < today) {
    return {
      code: "return_window",
      message: `Returns are accepted for ${RETURN_WINDOW_DAYS} days after the sale`,
    };
  }

  return null;
};

function checkSaleOpen(sale, today) {
  const problem = soldMessage(sale, today);

  if (problem) {
    throw new HttpError(409, problem.code, problem.message);
  }
}

const isExpired = (batch, today) => {
  const expiry = toDateString(batch.expirationDate);

  return expiry !== null && expiry < today;
};

const restockProblem = (batch, today) => {
  if (!RESTOCKABLE.includes(batch.batchStatus ?? batch.status)) {
    return `Batch ${batch.batchNumber} is ${(batch.batchStatus ?? batch.status).toLowerCase()} and cannot take returned stock; choose another disposition`;
  }

  if (isExpired(batch, today)) {
    return `Batch ${batch.batchNumber} has expired and cannot take returned stock; choose another disposition`;
  }

  return null;
};

// ---- checking a draft ----

function checkDraft(input, { pieces, byPiece, byItem }, today) {
  const errors = [];
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  const rawLines = Array.isArray(input?.lines) ? input.lines : [];
  const filled = rawLines
    .map((line, index) => {
      return { line, index };
    })
    .filter(({ line }) => {
      return !isBlank(line?.quantity);
    });

  if (reason === "" || reason.length > MAX_REASON) {
    errors.push({ path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` });
  }

  if (filled.length === 0 || filled.length > MAX_LINES || rawLines.length > MAX_LINES * 2) {
    errors.push({ path: "lines", message: `Return 1 to ${MAX_LINES} batches` });
  }

  const pieceById = new Map(
    pieces.map((piece) => {
      return [piece.id, piece];
    }),
  );
  const itemRunning = new Map();
  const seen = new Set();
  const rows = [];

  if (filled.length <= MAX_LINES && rawLines.length <= MAX_LINES * 2) {
    for (const { line, index } of filled) {
      const piece = isUuid(line.saleItemBatchId) ? pieceById.get(line.saleItemBatchId) : undefined;
      const quantityText = typeof line.quantity === "string" ? line.quantity.trim() : "";
      let ok = true;

      if (!piece) {
        errors.push({ path: `lines.${index}.saleItemBatchId`, message: "Unknown sale line" });
        continue;
      }

      if (seen.has(piece.id)) {
        errors.push({ path: `lines.${index}.saleItemBatchId`, message: "Already on this return" });
        continue;
      }

      seen.add(piece.id);

      const key = pieceKey(piece.saleItemId, piece.inventoryBatchId);
      const remaining = sub(piece.sold, byPiece.get(key) ?? "0");

      if (!QUANTITY.test(quantityText) || cmp(quantityText, "0") <= 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: "Enter a quantity above 0, up to 3 decimals",
        });
        ok = false;
      } else if (cmp(quantityText, remaining) > 0) {
        errors.push({
          path: `lines.${index}.quantity`,
          message: `Only ${toScale(remaining, 3)} left to return from this batch`,
        });
        ok = false;
      }

      if (!DISPOSITIONS.includes(line.disposition)) {
        errors.push({
          path: `lines.${index}.disposition`,
          message: "Choose what happens to the units",
        });
        ok = false;
      } else if (line.disposition === "RESTOCK") {
        const problem = restockProblem(piece, today);

        if (problem) {
          errors.push({ path: `lines.${index}.disposition`, message: problem });
          ok = false;
        }
      }

      if (!ok) {
        continue;
      }

      // the refund: the line's share, never more than is left of its total
      const running = itemRunning.get(piece.saleItemId) ??
        byItem.get(piece.saleItemId) ?? { quantity: "0", refund: "0" };
      const quantity = toScale(quantityText, 3);
      const left = sub(piece.itemTotal, running.refund);
      const lastUnits = cmp(add(running.quantity, quantity), piece.itemBaseQuantity) >= 0;
      const share = toScale(div(mul(piece.itemTotal, quantity), piece.itemBaseQuantity, 6), 2);
      const refund = toScale(lastUnits || cmp(share, left) > 0 ? left : share, 2);

      itemRunning.set(piece.saleItemId, {
        quantity: add(running.quantity, quantity),
        refund: add(running.refund, refund),
      });
      rows.push({
        piece,
        quantity,
        refund,
        disposition: line.disposition,
        unitPrice: toScale(div(piece.itemTotal, piece.itemBaseQuantity, 4), 4),
      });
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return { reason, rows };
}

function cleanReason(input, required) {
  const text = typeof input?.reason === "string" ? input.reason.trim() : "";

  if ((required && text === "") || text.length > MAX_REASON) {
    throw invalid("reason", `Give a reason of 1 to ${MAX_REASON} characters`);
  }

  return text === "" ? null : text;
}

// ---- writing ----

/**
 * A new DRAFT return for a finished sale in the actor's branch. `input` is `{ saleId, reason, lines:
 * [{ saleItemBatchId, quantity (base units), disposition }] }`; rows without a quantity are skipped.
 * Returns { id, returnNumber }.
 */
export async function createReturn(user, input, { now = new Date(), meta = {} } = {}) {
  if (!can(user, PERMISSIONS.RETURNS_CREATE)) {
    throw forbidden("You do not have permission to start a return");
  }

  if (!user.branchId) {
    throw forbidden("Returns belong to a branch, and this account has none");
  }

  if (!isUuid(input?.saleId)) {
    throw new HttpError(404, "not_found", "Sale not found");
  }

  return await db.transaction(
    async (tx) => {
      const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).for("update");

      if (!sale || sale.branchId !== user.branchId) {
        throw new HttpError(404, "not_found", "Sale not found");
      }

      const today = businessDate(now);

      checkSaleOpen(sale, today);

      const claims = await loadPieces(tx, sale.id);
      const draft = checkDraft(input, claims, today);
      const id = randomUUID();
      const returnNumber = await nextDocumentNumber(tx, "RET", user.branchCode, today);
      const refundAmount = toScale(
        sum(
          draft.rows.map((row) => {
            return row.refund;
          }),
        ),
        2,
      );

      await tx.insert(salesReturns).values({
        id,
        saleId: sale.id,
        branchId: user.branchId,
        returnNumber,
        customerId: sale.customerId,
        returnReason: draft.reason,
        refundAmount,
        status: "DRAFT",
        processedBy: user.id,
      });
      await tx.insert(salesReturnItems).values(
        draft.rows.map((row) => {
          return {
            id: randomUUID(),
            salesReturnId: id,
            saleItemId: row.piece.saleItemId,
            inventoryBatchId: row.piece.inventoryBatchId,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            refundAmount: row.refund,
            disposition: row.disposition,
          };
        }),
      );
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "RETURN_CREATED",
        entityType: "sales_return",
        entityId: id,
        newValues: {
          returnNumber,
          invoice: sale.invoiceNumber,
          refundAmount,
          lines: draft.rows.length,
        },
        reason: draft.reason,
        ...meta,
      });

      return { id, returnNumber };
    },
    { isolationLevel: "read committed" },
  );
}

/** Locks the return in the actor's branch and checks it is in one of the `from` states. */
async function lockReturn(tx, user, id, from, verb) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await tx.select().from(salesReturns).where(eq(salesReturns.id, id)).for("update");

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

      if (rule.distinct && row.processedBy === user.id) {
        throw forbidden("A different person must approve a return");
      }

      if (rule.guard && !rule.guard(user, row)) {
        throw forbidden("You do not have permission for this step");
      }

      await tx
        .update(salesReturns)
        .set({ status: rule.to, ...rule.set?.(user, now) })
        .where(eq(salesReturns.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "sales_return",
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
    action: "RETURN_SUBMITTED",
    needs: [PERMISSIONS.RETURNS_CREATE],
  },
  approve: {
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    verb: "approved",
    action: "RETURN_APPROVED",
    needs: [PERMISSIONS.RETURNS_APPROVE],
    distinct: true,
    set: (user) => {
      return { approvedBy: user.id };
    },
  },
  reject: {
    from: ["PENDING_APPROVAL"],
    to: "REJECTED",
    verb: "rejected",
    action: "RETURN_REJECTED",
    needs: [PERMISSIONS.RETURNS_APPROVE],
    reason: "required",
  },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
    to: "CANCELLED",
    verb: "cancelled",
    action: "RETURN_CANCELLED",
    needs: [PERMISSIONS.RETURNS_CREATE, PERMISSIONS.RETURNS_APPROVE],
    reason: "required",
    // once a manager approved it, only a manager takes it back
    guard: (user, row) => {
      return row.status !== "APPROVED" || can(user, PERMISSIONS.RETURNS_APPROVE);
    },
  },
};

export const submitReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.submit, options);
};
export const approveReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.approve, options);
};
export const rejectReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.reject, options);
};
export const cancelReturn = (user, id, input, options) => {
  return move(user, id, input, RULES.cancel, options);
};

// ---- processing ----

function checkRefundInput(input) {
  const method = input?.refundMethod;
  const reference = typeof input?.referenceNumber === "string" ? input.referenceNumber.trim() : "";

  if (!REFUND_METHODS.includes(method)) {
    throw invalid("refundMethod", "Choose how the refund is paid");
  }

  if (reference.length > MAX_REFERENCE) {
    throw invalid("referenceNumber", `Keep the reference under ${MAX_REFERENCE} characters`);
  }

  return { method, reference: reference === "" ? null : reference };
}

/**
 * APPROVED → PROCESSED. Pays the refund by `refundMethod` (a method the sale was paid with, with a
 * reference unless cash), puts RESTOCK lines back on their batch, and moves the sale's status. Cash
 * comes out of the processor's own open register. A deadlock with a sale is retried.
 */
export async function processReturn(user, id, input, options = {}) {
  const refund = checkRefundInput(input);

  if (!can(user, PERMISSIONS.RETURNS_APPROVE)) {
    throw forbidden("You do not have permission for this step");
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await processOnce(user, id, refund, options);
    } catch (error) {
      if (!isDeadlock(error) || attempt >= 3) {
        throw error;
      }
    }
  }
}

// What each payment method paid on a sale (cash net of change) less what it has already refunded.
async function refundableByMethod(tx, sale) {
  const paid = await tx
    .select({ method: salePayments.paymentMethod, amount: salePayments.amount })
    .from(salePayments)
    .where(and(eq(salePayments.saleId, sale.id), eq(salePayments.paymentStatus, "PAID")));
  const refunded = await tx
    .select({ method: refunds.paymentMethod, amount: refunds.amount })
    .from(refunds)
    .innerJoin(salesReturns, eq(salesReturns.id, refunds.salesReturnId))
    .where(and(eq(salesReturns.saleId, sale.id), eq(refunds.status, "PROCESSED")));
  const left = new Map();

  for (const row of paid) {
    left.set(row.method, add(left.get(row.method) ?? "0", row.amount));
  }

  if (left.has("CASH")) {
    left.set("CASH", sub(left.get("CASH"), sale.changeAmount));
  }

  for (const row of refunded) {
    left.set(row.method, sub(left.get(row.method) ?? "0", row.amount));
  }

  return left;
}

async function processOnce(user, id, { method, reference }, { now = new Date(), meta = {} }) {
  return await db.transaction(
    async (tx) => {
      const header = await lockReturn(tx, user, id, ["APPROVED"], "processed");
      const [sale] = await tx.select().from(sales).where(eq(sales.id, header.saleId)).for("update");
      const left = await refundableByMethod(tx, sale);
      const today = businessDate(now);

      if (!left.has(method)) {
        throw invalid(
          "refundMethod",
          `This sale was not paid by ${method}, so it cannot be refunded that way`,
        );
      }

      if (method !== "CASH" && reference === null) {
        throw invalid("referenceNumber", "Enter the reference of the refund");
      }

      if (cmp(header.refundAmount, left.get(method)) > 0) {
        throw invalid(
          "refundMethod",
          `Only ${toScale(left.get(method), 2)} is left to refund by ${method}`,
        );
      }

      let session = null;

      if (method === "CASH") {
        [session] = await tx
          .select()
          .from(cashRegisterSessions)
          .where(
            and(
              eq(cashRegisterSessions.cashierId, user.id),
              eq(cashRegisterSessions.status, "OPEN"),
            ),
          )
          .limit(1)
          .for("share");

        if (!session) {
          throw new HttpError(
            409,
            "register_closed",
            "Open a register before paying a cash refund",
          );
        }
      }

      const items = await tx
        .select()
        .from(salesReturnItems)
        .where(eq(salesReturnItems.salesReturnId, id))
        .orderBy(asc(salesReturnItems.inventoryBatchId));
      const restocks = items.filter((item) => {
        return item.disposition === "RESTOCK";
      });
      const restocked = await restockLines(tx, user, header, restocks, { now, today });

      await tx.insert(refunds).values({
        id: randomUUID(),
        salesReturnId: id,
        paymentMethod: method,
        amount: toScale(header.refundAmount, 2),
        referenceNumber: reference,
        status: "PROCESSED",
        processedAt: now,
      });

      if (session) {
        await tx.insert(cashTransactions).values({
          id: randomUUID(),
          cashRegisterSessionId: session.id,
          transactionType: "CASH_REFUND",
          amount: toScale(header.refundAmount, 2),
          referenceType: "sales_return",
          referenceId: id,
          reason: header.returnReason,
          performedBy: user.id,
        });
      }

      const settled = await tx
        .select({ amount: refunds.amount })
        .from(refunds)
        .innerJoin(salesReturns, eq(salesReturns.id, refunds.salesReturnId))
        .where(and(eq(salesReturns.saleId, sale.id), eq(refunds.status, "PROCESSED")));
      const everything =
        cmp(
          sum(
            settled.map((row) => {
              return row.amount;
            }),
          ),
          sale.totalAmount,
        ) >= 0;
      const saleStatus = everything ? "REFUNDED" : "PARTIALLY_REFUNDED";

      await tx.update(sales).set({ status: saleStatus }).where(eq(sales.id, sale.id));
      await tx.update(salesReturns).set({ status: "PROCESSED" }).where(eq(salesReturns.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "RETURN_PROCESSED",
        entityType: "sales_return",
        entityId: id,
        oldValues: { status: "APPROVED" },
        newValues: {
          status: "PROCESSED",
          refund: toScale(header.refundAmount, 2),
          method,
          saleStatus,
          restocked,
        },
        ...meta,
      });

      return { id, status: "PROCESSED", saleStatus };
    },
    { isolationLevel: "read committed" },
  );
}

// Puts RESTOCK lines back on their batches (inventory rows locked first, then batches, both in id
// order, like checkout). Returns how many batches changed.
async function restockLines(tx, user, header, restocks, { now, today }) {
  if (restocks.length === 0) {
    return 0;
  }

  const batchIds = [
    ...new Set(
      restocks.map((item) => {
        return item.inventoryBatchId;
      }),
    ),
  ].sort();
  const probes = await tx
    .select({ inventoryId: inventoryBatches.inventoryId, productId: inventoryBatches.productId })
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
  const added = new Map();

  for (const item of restocks) {
    added.set(item.inventoryBatchId, add(added.get(item.inventoryBatchId) ?? "0", item.quantity));
  }

  const onHand = new Map();

  for (const [batchId, quantity] of added) {
    const batch = batchById.get(batchId);
    const problem = restockProblem(batch, today);
    const after = add(batch.quantityAvailable, quantity);

    if (problem || cmp(after, batch.quantityReceived) > 0) {
      throw new HttpError(
        409,
        "return_restock",
        `${problem ?? `Batch ${batch.batchNumber} cannot hold that many units`}. Cancel this return and draft it again.`,
      );
    }

    await tx
      .update(inventoryBatches)
      .set({
        quantityAvailable: toScale(after, 3),
        status: batch.status === "DEPLETED" ? "ACTIVE" : batch.status,
      })
      .where(eq(inventoryBatches.id, batchId));
    await tx.insert(inventoryMovements).values({
      id: randomUUID(),
      branchId: batch.branchId,
      productId: batch.productId,
      inventoryBatchId: batchId,
      movementType: "SALE_RETURN",
      referenceType: "sales_return",
      referenceId: header.id,
      quantityChange: toScale(quantity, 3),
      quantityBefore: toScale(batch.quantityAvailable, 3),
      quantityAfter: toScale(after, 3),
      unitCost: batch.unitCost,
      reason: header.returnReason,
      performedBy: user.id,
      createdAt: now,
    });
    onHand.set(batch.inventoryId, add(onHand.get(batch.inventoryId) ?? "0", quantity));
  }

  for (const [inventoryId, quantity] of onHand) {
    await tx
      .update(inventories)
      .set({ quantityOnHand: toScale(add(stockById.get(inventoryId).quantityOnHand, quantity), 3) })
      .where(eq(inventories.id, inventoryId));
  }

  return batchIds.length;
}

// ---- reading ----

const sees = (user, branchId) => {
  return branchId === user.branchId || can(user, PERMISSIONS.SALES_VIEW_ALL);
};

const approvers = alias(users, "approvers");

const headerSelect = {
  id: salesReturns.id,
  returnNumber: salesReturns.returnNumber,
  saleId: salesReturns.saleId,
  invoiceNumber: sales.invoiceNumber,
  branchId: salesReturns.branchId,
  branchName: branches.name,
  status: salesReturns.status,
  reason: salesReturns.returnReason,
  refundAmount: salesReturns.refundAmount,
  createdBy: salesReturns.processedBy,
  createdByName: users.name,
  approvedBy: salesReturns.approvedBy,
  approvedByName: approvers.name,
  createdAt: salesReturns.createdAt,
};

function headerQuery(executor) {
  return executor
    .select(headerSelect)
    .from(salesReturns)
    .innerJoin(sales, eq(sales.id, salesReturns.saleId))
    .innerJoin(branches, eq(branches.id, salesReturns.branchId))
    .innerJoin(users, eq(users.id, salesReturns.processedBy))
    .leftJoin(approvers, eq(approvers.id, salesReturns.approvedBy));
}

/** One return with its lines and refund. Other branches are a 404 unless the user has the all-branch scope. */
export async function getReturn(user, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [salesReturn] = await headerQuery(db).where(eq(salesReturns.id, id));

  if (!salesReturn || !sees(user, salesReturn.branchId)) {
    throw notFound();
  }

  const lines = await db
    .select({
      id: salesReturnItems.id,
      productName: saleItems.productNameSnapshot,
      batchNumber: inventoryBatches.batchNumber,
      quantity: salesReturnItems.quantity,
      refundAmount: salesReturnItems.refundAmount,
      disposition: salesReturnItems.disposition,
    })
    .from(salesReturnItems)
    .innerJoin(saleItems, eq(saleItems.id, salesReturnItems.saleItemId))
    .leftJoin(inventoryBatches, eq(inventoryBatches.id, salesReturnItems.inventoryBatchId))
    .where(eq(salesReturnItems.salesReturnId, id))
    .orderBy(
      asc(saleItems.productNameSnapshot),
      asc(inventoryBatches.batchNumber),
      asc(salesReturnItems.id),
    );
  const [refund] = await db
    .select({
      method: refunds.paymentMethod,
      amount: refunds.amount,
      referenceNumber: refunds.referenceNumber,
      processedAt: refunds.processedAt,
    })
    .from(refunds)
    .where(eq(refunds.salesReturnId, id))
    .limit(1);

  const [sale] = await db.select().from(sales).where(eq(sales.id, salesReturn.saleId));
  const left = await refundableByMethod(db, sale);

  return {
    salesReturn,
    // the methods this sale can still be refunded by, with what each has left
    refundable: [...left]
      .filter(([, amount]) => {
        return cmp(amount, "0") > 0;
      })
      .map(([method, amount]) => {
        return { method, left: toScale(amount, 2) };
      }),
    lines: lines.map((line) => {
      return {
        ...line,
        quantity: toScale(line.quantity, 3),
        refundAmount: toScale(line.refundAmount, 2),
      };
    }),
    refund: refund ?? null,
  };
}

/** Returns newest first, in the user's branch (all branches with the all-branch scope). */
export async function listReturns(user, { status, page = 1 } = {}) {
  const conditions = [];

  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    conditions.push(eq(salesReturns.branchId, user.branchId ?? ""));
  }

  if (RETURN_STATUSES.includes(status)) {
    conditions.push(eq(salesReturns.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageNumber = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
  const [{ n }] = await db.select({ n: count() }).from(salesReturns).where(where);
  const rows = await headerQuery(db)
    .where(where)
    .orderBy(desc(salesReturns.createdAt), desc(salesReturns.returnNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return { rows, total: n, page: pageNumber, pageSize: PAGE_SIZE };
}

/**
 * What the return form shows for a sale in the user's branch: the sale, the batch pieces with how
 * much of each is still returnable, and `blocked` (a sentence, or null) when no return can start.
 */
export async function getReturnableSale(user, saleId, { now = new Date() } = {}) {
  if (!isUuid(saleId)) {
    throw new HttpError(404, "not_found", "Sale not found");
  }

  const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));

  if (!sale || sale.branchId !== user.branchId) {
    throw new HttpError(404, "not_found", "Sale not found");
  }

  const { pieces, byPiece } = await loadPieces(db, saleId);

  return {
    sale: {
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      status: sale.status,
      totalAmount: toScale(sale.totalAmount, 2),
      transactionDate: sale.transactionDate,
    },
    blocked: soldMessage(sale, businessDate(now))?.message ?? null,
    pieces: pieces.map((piece) => {
      const returned = byPiece.get(pieceKey(piece.saleItemId, piece.inventoryBatchId)) ?? "0";

      return {
        id: piece.id,
        productName: piece.productName,
        batchNumber: piece.batchNumber,
        expirationDate: toDateString(piece.expirationDate),
        sold: toScale(piece.sold, 3),
        returned: toScale(returned, 3),
        remaining: toScale(sub(piece.sold, returned), 3),
      };
    }),
  };
}
