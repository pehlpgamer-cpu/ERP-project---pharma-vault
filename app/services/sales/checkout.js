// Checkout: one READ COMMITTED transaction prices the cart, allocates stock first-expiry-first-out,
// numbers the invoice and writes the sale together with its stock and cash ledgers. Anything that
// fails rolls the whole sale back. Locks are always taken in the same order (register session,
// inventories by product id, batches, invoice sequence), so concurrent sales queue instead of
// deadlocking; a deadlock that still happens is retried.

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { cashRegisterSessions } from "../../models/cash-register-sessions.js";
import { cashRegisters } from "../../models/cash-registers.js";
import { cashTransactions } from "../../models/cash-transactions.js";
import { customers } from "../../models/customers.js";
import { documentSequences } from "../../models/document-sequences.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";
import { saleItemBatches } from "../../models/sale-item-batches.js";
import { saleItems } from "../../models/sale-items.js";
import { salePayments } from "../../models/sale-payments.js";
import { sales } from "../../models/sales.js";
import { recordAudit } from "../audit/auditLog.js";
import { loadEffectivePrices } from "../catalog/pricing.js";
import { add, cmp, div, isDecimal, mul, sub, sum, toScale } from "../support/decimal.js";
import { isDeadlock, isDuplicateEntry } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";
import { expiryBufferDays } from "../support/settings.js";
import { addDays, businessDate } from "../support/time.js";
import { allocateFefo } from "./fefo.js";

const MAX_ATTEMPTS = 3;
const MONEY_SCALE = 2;
const QUANTITY_SCALE = 3;
const PAYMENT_METHODS = ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"];

const paymentInvalid = (message) => {
  return new HttpError(422, "payment_invalid", message, [{ path: "payments", message }]);
};

const invalidField = (path, message) => {
  return new ValidationError([{ path, message }]);
};

function replayOf(stored, user) {
  if (stored.cashierId !== user.id) {
    throw new HttpError(
      409,
      "idempotency_conflict",
      "That Idempotency-Key was already used by another user",
    );
  }

  return { saleId: stored.id, replayed: true };
}

async function findByKey(executor, key) {
  const [row] = await executor
    .select({ id: sales.id, cashierId: sales.cashierId })
    .from(sales)
    .where(eq(sales.idempotencyKey, key))
    .limit(1);

  return row ?? null;
}

// The error raised when a concurrent request with the same key committed first.
function violatesIdempotencyKey(error) {
  const text = error?.cause?.sqlMessage ?? error?.sqlMessage ?? error?.message ?? "";

  return isDuplicateEntry(error) && String(text).includes("uq_sales_idempotency");
}

const trimmed = (value) => {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

// Step 2: the cart as priced lines, or the first rule it breaks. Reads only, nothing is locked yet.
async function resolveLines(tx, items, { branchId, now }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw invalidField("items", "Add at least one item");
  }

  items.forEach((item, index) => {
    if (!isUuid(item.productUnitId)) {
      throw invalidField(`items.${index}.productUnitId`, "Unknown or unavailable unit");
    }

    if (!isDecimal(item.quantity) || cmp(toScale(item.quantity, QUANTITY_SCALE), "0") <= 0) {
      throw invalidField(`items.${index}.quantity`, "Quantity must be more than zero");
    }
  });

  const unitIds = [
    ...new Set(
      items.map((item) => {
        return item.productUnitId;
      }),
    ),
  ];
  const rows = await tx
    .select({
      productUnitId: productUnits.id,
      productId: products.id,
      productName: products.productName,
      genericName: products.genericName,
      classification: products.prescriptionClassification,
      requiresPrescription: products.requiresPrescription,
      productActive: products.isActive,
      unitActive: productUnits.isActive,
      canBeSold: productUnits.canBeSold,
      conversionFactor: productUnits.conversionFactor,
    })
    .from(productUnits)
    .innerJoin(products, eq(products.id, productUnits.productId))
    .where(inArray(productUnits.id, unitIds));
  const byUnit = new Map(
    rows.map((row) => {
      return [row.productUnitId, row];
    }),
  );
  const prices = await loadEffectivePrices(tx, unitIds, branchId, now);

  return items.map((item, index) => {
    const unit = byUnit.get(item.productUnitId);

    if (!unit || !unit.unitActive || !unit.canBeSold || !unit.productActive) {
      throw invalidField(`items.${index}.productUnitId`, "Unknown or unavailable unit");
    }

    if (unit.classification !== "OTC" || unit.requiresPrescription) {
      throw new HttpError(
        422,
        "prescription_required",
        `${unit.productName} needs a prescription and cannot be sold at the counter`,
        [{ productId: unit.productId, productName: unit.productName }],
      );
    }

    const unitPrice = prices.get(unit.productUnitId);

    if (unitPrice === undefined) {
      throw new HttpError(422, "no_price", `${unit.productName} has no price in this unit`, [
        { productId: unit.productId, productUnitId: unit.productUnitId },
      ]);
    }

    const quantity = toScale(item.quantity, QUANTITY_SCALE);
    const baseQuantity = toScale(mul(quantity, unit.conversionFactor), QUANTITY_SCALE);

    if (cmp(baseQuantity, "0") <= 0) {
      throw invalidField(`items.${index}.quantity`, "Quantity is too small to sell");
    }

    return {
      productId: unit.productId,
      productUnitId: unit.productUnitId,
      productName: unit.productName,
      genericName: unit.genericName,
      quantity,
      baseQuantity,
      unitPrice,
      subtotal: toScale(mul(quantity, unitPrice), MONEY_SCALE),
    };
  });
}

// Step 2, payments: they must cover the total, and change must come out of the cash.
function checkPayments(payments, total) {
  if (!Array.isArray(payments) || payments.length === 0) {
    throw paymentInvalid("Add at least one payment");
  }

  for (const payment of payments) {
    if (!PAYMENT_METHODS.includes(payment.method)) {
      throw paymentInvalid("Unknown payment method");
    }

    if (!isDecimal(payment.amount) || cmp(toScale(payment.amount, MONEY_SCALE), "0") <= 0) {
      throw paymentInvalid("Each payment must be more than zero");
    }
  }

  const electronic = payments.filter((payment) => {
    return payment.method !== "CASH";
  });
  const tendered = toScale(
    sum(
      payments.map((payment) => {
        return payment.amount;
      }),
    ),
    MONEY_SCALE,
  );

  if (cmp(tendered, total) < 0) {
    throw paymentInvalid("The payments do not cover the total");
  }

  const electronicTotal = sum(
    electronic.map((payment) => {
      return payment.amount;
    }),
  );

  if (cmp(electronicTotal, total) > 0) {
    throw paymentInvalid("Non-cash payments cannot be more than the total");
  }

  if (
    electronic.some((payment) => {
      return trimmed(payment.reference) === null;
    })
  ) {
    throw paymentInvalid("Every non-cash payment needs a reference");
  }

  return { tendered, change: toScale(sub(tendered, total), MONEY_SCALE) };
}

// The product's sellable batches, locked, in the order stock should leave the shelf.
function lockSellableBatches(tx, { branchId, productId, cutoff }) {
  return tx
    .select()
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.branchId, branchId),
        eq(inventoryBatches.productId, productId),
        eq(inventoryBatches.status, "ACTIVE"),
        gt(inventoryBatches.quantityAvailable, "0"),
        sql`(${inventoryBatches.expirationDate} IS NULL OR ${inventoryBatches.expirationDate} >= ${cutoff})`,
      ),
    )
    .orderBy(
      sql`${inventoryBatches.expirationDate} IS NULL`,
      asc(inventoryBatches.expirationDate),
      asc(inventoryBatches.receivedAt),
      asc(inventoryBatches.id),
    )
    .for("update");
}

const insufficientStock = (productId, requested, available) => {
  return new HttpError(409, "insufficient_stock", "There is not enough stock for this sale", [
    { productId, requested, available },
  ]);
};

// Step 4: takes the stock for each line, one line after another against the rows already updated.
// Returns the receipt batches and stock movements to write, and the base quantity sold per product.
async function allocateStock(tx, lines, { branchId, today, bufferDays, inventoryByProduct }) {
  const rule = { today, bufferDays };
  const cutoff = addDays(today, bufferDays);
  const requested = new Map();
  const taken = new Map();
  const results = [];

  for (const line of lines) {
    requested.set(line.productId, add(requested.get(line.productId) ?? "0", line.baseQuantity));
  }

  for (const line of lines) {
    const already = taken.get(line.productId) ?? toScale("0", QUANTITY_SCALE);
    const batches = inventoryByProduct.has(line.productId)
      ? await lockSellableBatches(tx, { branchId, productId: line.productId, cutoff })
      : [];
    const { allocations, shortfall } = allocateFefo(batches, line.baseQuantity, rule);

    if (cmp(shortfall, "0") > 0) {
      // what the shelf held for this product when the sale began
      const available = toScale(add(sub(line.baseQuantity, shortfall), already), QUANTITY_SCALE);

      throw insufficientStock(
        line.productId,
        toScale(requested.get(line.productId), QUANTITY_SCALE),
        available,
      );
    }

    const byId = new Map(
      batches.map((batch) => {
        return [batch.id, batch];
      }),
    );
    const used = [];

    for (const { batchId, quantity } of allocations) {
      const batch = byId.get(batchId);
      const after = toScale(sub(batch.quantityAvailable, quantity), QUANTITY_SCALE);

      await tx
        .update(inventoryBatches)
        .set({
          quantityAvailable: after,
          status: cmp(after, "0") === 0 ? "DEPLETED" : batch.status,
        })
        .where(eq(inventoryBatches.id, batch.id));
      used.push({
        batchId,
        quantity,
        unitCost: batch.unitCost,
        before: batch.quantityAvailable,
        after,
      });
    }

    taken.set(line.productId, toScale(add(already, line.baseQuantity), QUANTITY_SCALE));
    results.push({ line, used });
  }

  return { results, soldByProduct: taken };
}

// Step 5: the next invoice number for the branch and business day. Gap-free, because a rollback
// undoes the increment.
async function nextInvoiceNumber(tx, branchCode, today) {
  const day = today.replaceAll("-", "");
  const scope = `invoice:${branchCode}:${day}`;

  await tx
    .insert(documentSequences)
    .values({ scope, lastValue: 1 })
    .onDuplicateKeyUpdate({ set: { lastValue: sql`${documentSequences.lastValue} + 1` } });

  const [counter] = await tx
    .select({ lastValue: documentSequences.lastValue })
    .from(documentSequences)
    .where(eq(documentSequences.scope, scope));

  return `${branchCode}-${day}-${String(counter.lastValue).padStart(4, "0")}`;
}

// Steps 1 to 6 (the commit is the caller's). Takes the clock as a parameter.
async function postSale(tx, { user, input, key, now, onStep, meta }) {
  // 1. the user's open register session; a close has to wait for this sale
  const [session] = await tx
    .select()
    .from(cashRegisterSessions)
    .where(
      and(eq(cashRegisterSessions.cashierId, user.id), eq(cashRegisterSessions.status, "OPEN")),
    )
    .limit(1)
    .for("share");

  if (!session) {
    throw new HttpError(409, "register_closed", "Open a register before selling");
  }

  const [{ branchId, branchCode }] = await tx
    .select({ branchId: branches.id, branchCode: branches.code })
    .from(cashRegisters)
    .innerJoin(branches, eq(branches.id, cashRegisters.branchId))
    .where(eq(cashRegisters.id, session.cashRegisterId));

  // 2. price the cart and check the payments, before anything else is locked
  const lines = await resolveLines(tx, input.items, { branchId, now });
  const subtotal = toScale(
    sum(
      lines.map((line) => {
        return line.subtotal;
      }),
    ),
    MONEY_SCALE,
  );
  const total = subtotal;
  const { tendered, change } = checkPayments(input.payments, total);
  const customerId = input.customerId ?? null;

  if (customerId !== null) {
    const known = isUuid(customerId)
      ? await tx
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, customerId))
          .limit(1)
      : [];

    if (known.length === 0) {
      throw invalidField("customerId", "Unknown customer");
    }
  }

  // 3. lock the inventory rows of every product, always in product id order
  const productIds = [
    ...new Set(
      lines.map((line) => {
        return line.productId;
      }),
    ),
  ].sort();
  const inventoryRows = await tx
    .select()
    .from(inventories)
    .where(and(eq(inventories.branchId, branchId), inArray(inventories.productId, productIds)))
    .orderBy(asc(inventories.productId))
    .for("update");
  const inventoryByProduct = new Map(
    inventoryRows.map((row) => {
      return [row.productId, row];
    }),
  );

  // A duplicate request that waited for those locks finds the first one's sale here.
  const stored = await findByKey(tx, key);

  if (stored) {
    return replayOf(stored, user);
  }

  // 4. take the stock
  const today = businessDate(now);
  const { results, soldByProduct } = await allocateStock(tx, lines, {
    branchId,
    today,
    bufferDays: expiryBufferDays(),
    inventoryByProduct,
  });

  await onStep?.("allocated");

  // 5. the invoice number, last, so the sequence lock is held as briefly as possible
  const invoiceNumber = await nextInvoiceNumber(tx, branchCode, today);

  // 6. the sale, in foreign-key order
  const saleId = randomUUID();

  await tx.insert(sales).values({
    id: saleId,
    branchId,
    customerId,
    cashierId: user.id,
    cashRegisterSessionId: session.id,
    invoiceNumber,
    transactionDate: now,
    subtotal,
    discountAmount: toScale("0", MONEY_SCALE),
    taxAmount: toScale("0", MONEY_SCALE),
    totalAmount: total,
    amountPaid: tendered,
    changeAmount: change,
    status: "COMPLETED",
    idempotencyKey: key,
  });

  const itemRows = [];
  const itemBatchRows = [];
  const movementRows = [];

  for (const { line, used } of results) {
    const itemId = randomUUID();
    const totalCost = sum(
      used.map((part) => {
        return mul(part.quantity, part.unitCost);
      }),
    );

    itemRows.push({
      id: itemId,
      saleId,
      productId: line.productId,
      productUnitId: line.productUnitId,
      productNameSnapshot: line.productName,
      genericNameSnapshot: line.genericName,
      quantity: line.quantity,
      baseQuantity: line.baseQuantity,
      unitPrice: line.unitPrice,
      unitCost: div(totalCost, line.quantity, 4),
      discountAmount: toScale("0", MONEY_SCALE),
      taxAmount: toScale("0", MONEY_SCALE),
      subtotal: line.subtotal,
      totalAmount: line.subtotal,
    });

    for (const part of used) {
      itemBatchRows.push({
        saleItemId: itemId,
        inventoryBatchId: part.batchId,
        quantity: part.quantity,
        unitCost: part.unitCost,
      });
      movementRows.push({
        branchId,
        productId: line.productId,
        inventoryBatchId: part.batchId,
        movementType: "SALE",
        referenceType: "sale",
        referenceId: saleId,
        quantityChange: sub("0", part.quantity),
        quantityBefore: part.before,
        quantityAfter: part.after,
        unitCost: part.unitCost,
        performedBy: user.id,
      });
    }
  }

  await tx.insert(saleItems).values(itemRows);
  await tx.insert(saleItemBatches).values(itemBatchRows);
  await onStep?.("sale-inserted");

  await tx.insert(inventoryMovements).values(movementRows);
  await tx.insert(salePayments).values(
    input.payments.map((payment) => {
      return {
        saleId,
        paymentMethod: payment.method,
        amount: toScale(payment.amount, MONEY_SCALE),
        referenceNumber: trimmed(payment.reference),
        paymentStatus: "PAID",
        paidAt: now,
      };
    }),
  );

  const cashTendered = sum(
    input.payments
      .filter((payment) => {
        return payment.method === "CASH";
      })
      .map((payment) => {
        return payment.amount;
      }),
  );

  if (
    input.payments.some((payment) => {
      return payment.method === "CASH";
    })
  ) {
    await tx.insert(cashTransactions).values({
      cashRegisterSessionId: session.id,
      transactionType: "CASH_SALE",
      amount: toScale(sub(cashTendered, change), MONEY_SCALE),
      referenceType: "sale",
      referenceId: saleId,
      performedBy: user.id,
    });
  }

  for (const [productId, sold] of soldByProduct) {
    const inventory = inventoryByProduct.get(productId);

    await tx
      .update(inventories)
      .set({ quantityOnHand: toScale(sub(inventory.quantityOnHand, sold), QUANTITY_SCALE) })
      .where(eq(inventories.id, inventory.id));
  }

  await recordAudit(tx, {
    userId: user.id,
    branchId,
    action: "SALE_COMPLETED",
    entityType: "sale",
    entityId: saleId,
    newValues: { invoiceNumber, total, amountPaid: tendered, change, lines: lines.length },
    ...meta,
  });
  await onStep?.("ledger-written");

  return { saleId, replayed: false };
}

/**
 * Completes a sale for the user's open register session. `input` is already normalized (quantities
 * with 3 places, amounts with 2). Returns the sale id, and `replayed: true` when the idempotency key
 * already produced a sale for this user. Throws HttpError with the codes register_closed, no_price,
 * prescription_required, payment_invalid, insufficient_stock, idempotency_conflict, and
 * validation_failed; any failure leaves no trace.
 *
 * `onStep` is called after "allocated", "sale-inserted" and "ledger-written" (tests use it to inject
 * failures); `meta` is `{ ipAddress, userAgent }` for the audit row.
 */
export async function createSale(
  user,
  input,
  idempotencyKey,
  { now = new Date(), onStep, meta = {} } = {},
) {
  const known = await findByKey(db, idempotencyKey);

  if (known) {
    return replayOf(known, user);
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(
        (tx) => {
          return postSale(tx, { user, input, key: idempotencyKey, now, onStep, meta });
        },
        { isolationLevel: "read committed" },
      );
    } catch (error) {
      if (violatesIdempotencyKey(error)) {
        // a concurrent request with this key committed first: answer with its sale
        const stored = await findByKey(db, idempotencyKey);

        if (stored) {
          return replayOf(stored, user);
        }
      }

      if (!isDeadlock(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}
