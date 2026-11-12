// Goods receiving: posting a receipt is the only thing that turns purchased goods into stock. One
// transaction locks the order, its lines and each product's inventory row (in product-id order),
// creates a batch per accepted line, raises on hand, writes the movements and updates the order.
// Rejected goods are recorded on the receipt but never become stock. A supplier invoice number is
// received once per order, so a retried post is a 409 and creates nothing.

import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { goodsReceiptItems } from "../../models/goods-receipt-items.js";
import { goodsReceipts } from "../../models/goods-receipts.js";
import { inventories } from "../../models/inventories.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { inventoryMovements } from "../../models/inventory-movements.js";
import { purchaseOrderItems } from "../../models/purchase-order-items.js";
import { purchaseOrders } from "../../models/purchase-orders.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { add, cmp, div, mul, sub, toScale } from "../support/decimal.js";
import { isDuplicateEntry } from "../support/dbErrors.js";
import { businessDate, isRealDay } from "../support/time.js";
import { nextDocumentNumber } from "./numbers.js";
import { lockOrder } from "./purchaseOrders.js";

// two rows per order line (a split batch) for up to 100 order lines
const MAX_LINES = 200;
// DECIMAL(14,3) holds 11 whole digits
const MAX_QUANTITY = "99999999999.999";
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;

const duplicateReceipt = () => {
  return new HttpError(
    409,
    "receipt_duplicate",
    "This supplier invoice has already been received on this order",
  );
};

const text = (value) => {
  return typeof value === "string" ? value.trim() : "";
};

const isDay = isRealDay;

const atMidnight = (day) => {
  return new Date(`${day}T00:00:00Z`);
};

/** Errors carry an `order` (line index, -1 for the header) that only sorts them. */
function raise(errors) {
  throw new ValidationError(
    errors
      .map((error, position) => {
        return { ...error, position };
      })
      .sort((a, b) => {
        return a.order - b.order || a.position - b.position;
      })
      .map(({ path, message }) => {
        return { path, message };
      }),
  );
}

function quantityOf(value, errors, index, field) {
  const raw = typeof value === "string" ? value.trim() : value;

  if (raw === undefined || raw === null || raw === "") {
    return "0.000";
  }

  if (typeof raw !== "string" || !QUANTITY.test(raw)) {
    errors.push({
      path: `lines.${index}.${field}`,
      message: "Enter a quantity of 0 or more (up to 3 decimals)",
      order: index,
    });

    return "0.000";
  }

  return toScale(raw, 3);
}

/** Checks everything that does not need the database. Returns the receipt header and its lines. */
function checkInput(input, today) {
  const errors = [];
  const invoice = text(input?.supplierInvoiceNumber);
  const notes = text(input?.notes);
  const raw = Array.isArray(input?.lines) ? input.lines : [];

  if (raw.length > MAX_LINES) {
    errors.push({ path: "lines", message: `Too many rows (at most ${MAX_LINES})`, order: -1 });
  }

  if (invoice === "" || invoice.length > 100) {
    errors.push({
      path: "supplierInvoiceNumber",
      message: "Enter the supplier invoice number (up to 100 characters)",
      order: -1,
    });
  }

  if (notes.length > 2000) {
    errors.push({ path: "notes", message: "Notes are at most 2000 characters", order: -1 });
  }

  const lines = [];

  raw.forEach((line, index) => {
    const accepted = quantityOf(line?.quantityAccepted, errors, index, "quantityAccepted");
    const rejected = quantityOf(line?.quantityRejected, errors, index, "quantityRejected");

    // blank rows (nothing delivered for that order line) are ignored
    if (cmp(accepted, "0") === 0 && cmp(rejected, "0") === 0) {
      return;
    }

    const row = { index, purchaseOrderItemId: line?.purchaseOrderItemId, accepted, rejected };
    const problem = (field, message) => {
      errors.push({ path: `lines.${index}.${field}`, message, order: index });
    };

    if (typeof row.purchaseOrderItemId !== "string" || row.purchaseOrderItemId === "") {
      problem("purchaseOrderItemId", "Choose the order line this delivery belongs to");
    }

    if (cmp(accepted, "0") > 0) {
      row.batchNumber = text(line?.batchNumber);
      row.expirationDate = text(line?.expirationDate);
      row.manufacturingDate = text(line?.manufacturingDate);

      if (row.batchNumber === "" || row.batchNumber.length > 100) {
        problem("batchNumber", "Enter the batch number (up to 100 characters)");
      }

      if (!isDay(row.expirationDate)) {
        problem("expirationDate", "Enter the expiry date");
      } else if (row.expirationDate <= today) {
        problem("expirationDate", "Expired or expiring today: this cannot be accepted into stock");
      }

      if (row.manufacturingDate !== "") {
        if (!isDay(row.manufacturingDate)) {
          problem("manufacturingDate", "Enter a valid manufacturing date");
        } else if (isDay(row.expirationDate) && row.manufacturingDate > row.expirationDate) {
          problem("manufacturingDate", "Manufactured after it expires");
        }
      }
    }

    if (cmp(rejected, "0") > 0) {
      row.reason = text(line?.rejectionReason);

      if (row.reason === "" || row.reason.length > 500) {
        problem("rejectionReason", "Say why it was rejected (up to 500 characters)");
      }
    }

    lines.push(row);
  });

  if (lines.length === 0 && errors.length === 0) {
    errors.push({
      path: "lines",
      message: "Enter what was delivered on at least one line",
      order: -1,
    });
  }

  if (errors.length > 0) {
    raise(errors);
  }

  return { invoice, notes: notes === "" ? null : notes, lines };
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
 * Posts a goods receipt against a SENT or PARTIALLY_RECEIVED order of the actor's branch.
 * input: { supplierInvoiceNumber, notes?, lines: [{ purchaseOrderItemId, batchNumber,
 * manufacturingDate?, expirationDate, quantityAccepted, quantityRejected?, rejectionReason? }] }
 * (quantities in the order line's purchase unit). Returns { receiptId, receiptNumber, orderStatus }.
 */
export async function postReceipt(user, orderId, input, { now = new Date(), meta = {} } = {}) {
  if (!can(user, PERMISSIONS.INVENTORY_RECEIVE)) {
    throw new HttpError(403, "forbidden", "You do not have permission to receive stock");
  }

  const today = businessDate(now);
  const receipt = checkInput(input, today);

  try {
    return await db.transaction(
      async (tx) => {
        const order = await lockOrder(
          tx,
          user,
          orderId,
          ["SENT", "PARTIALLY_RECEIVED"],
          "received",
        );
        const [already] = await tx
          .select({ id: goodsReceipts.id })
          .from(goodsReceipts)
          .where(
            and(
              eq(goodsReceipts.purchaseOrderId, order.id),
              eq(goodsReceipts.supplierInvoiceNumber, receipt.invoice),
            ),
          );

        if (already) {
          throw duplicateReceipt();
        }

        const items = new Map(
          (
            await tx
              .select()
              .from(purchaseOrderItems)
              .where(eq(purchaseOrderItems.purchaseOrderId, order.id))
              .for("update")
          ).map((item) => {
            return [item.id, item];
          }),
        );

        // what each order line may still take, counting the lines of this receipt in order
        const errors = [];
        const takenNow = new Map();

        for (const line of receipt.lines) {
          const item = items.get(line.purchaseOrderItemId);

          if (!item) {
            errors.push({
              path: `lines.${line.index}.purchaseOrderItemId`,
              message: "That line is not on this order",
              order: line.index,
            });
            continue;
          }

          line.item = item;

          const taken = add(takenNow.get(item.id) ?? "0", line.accepted);
          const open = sub(item.quantityOrdered, item.quantityReceived);

          takenNow.set(item.id, taken);

          if (cmp(taken, open) > 0) {
            errors.push({
              path: `lines.${line.index}.quantityAccepted`,
              message: `More than is still open on the order (${toScale(open, 3)})`,
              order: line.index,
            });
          }
        }

        if (errors.length > 0) {
          raise(errors);
        }

        const receiptId = randomUUID();
        const receiptNumber = await nextDocumentNumber(tx, "GR", user.branchCode, today);

        await tx.insert(goodsReceipts).values({
          id: receiptId,
          receiptNumber,
          purchaseOrderId: order.id,
          branchId: order.branchId,
          supplierInvoiceNumber: receipt.invoice,
          status: "POSTED",
          receivedAt: now,
          receivedBy: user.id,
          notes: receipt.notes,
        });

        // inventory rows in product-id order, so two receipts never wait on each other in a circle
        const productIds = [
          ...new Set(
            receipt.lines
              .filter((line) => {
                return cmp(line.accepted, "0") > 0;
              })
              .map((line) => {
                return line.item.productId;
              }),
          ),
        ].sort();
        const stock = new Map();

        for (const productId of productIds) {
          const inventory = await lockInventory(tx, order.branchId, productId);

          stock.set(productId, { id: inventory.id, onHand: toScale(inventory.quantityOnHand, 3) });
        }

        const itemRows = [];

        for (const line of receipt.lines) {
          const { item } = line;
          const hasStock = cmp(line.accepted, "0") > 0;
          const base = hasStock ? toScale(mul(line.accepted, item.conversionFactor), 3) : "0.000";
          const cost = toScale(div(item.unitCost, item.conversionFactor, 4), 4);
          let batchId = null;

          if (hasStock) {
            const inventory = stock.get(item.productId);
            const before = inventory.onHand;

            if (cmp(base, MAX_QUANTITY) > 0 || cmp(add(before, base), MAX_QUANTITY) > 0) {
              raise([
                {
                  path: `lines.${line.index}.quantityAccepted`,
                  message: "That much stock is too large to record",
                  order: line.index,
                },
              ]);
            }

            batchId = randomUUID();
            inventory.onHand = toScale(add(before, base), 3);

            await tx.insert(inventoryBatches).values({
              id: batchId,
              inventoryId: inventory.id,
              productId: item.productId,
              branchId: order.branchId,
              batchNumber: line.batchNumber,
              expirationDate: atMidnight(line.expirationDate),
              manufacturingDate:
                line.manufacturingDate === "" ? null : atMidnight(line.manufacturingDate),
              quantityReceived: base,
              quantityAvailable: base,
              unitCost: cost,
              receivedAt: now,
              status: "ACTIVE",
            });
            await tx.insert(inventoryMovements).values({
              id: randomUUID(),
              branchId: order.branchId,
              productId: item.productId,
              inventoryBatchId: batchId,
              movementType: "PURCHASE_RECEIVED",
              referenceType: "goods_receipt",
              referenceId: receiptId,
              quantityChange: base,
              quantityBefore: "0.000",
              quantityAfter: base,
              unitCost: cost,
              reason: `Received on ${receiptNumber}`,
              performedBy: user.id,
              createdAt: now,
            });
          }

          itemRows.push({
            id: randomUUID(),
            goodsReceiptId: receiptId,
            purchaseOrderItemId: item.id,
            productId: item.productId,
            inventoryBatchId: batchId,
            batchNumber: hasStock ? line.batchNumber : null,
            manufacturingDate:
              hasStock && line.manufacturingDate !== "" ? atMidnight(line.manufacturingDate) : null,
            expirationDate: hasStock ? atMidnight(line.expirationDate) : null,
            quantityReceived: toScale(add(line.accepted, line.rejected), 3),
            quantityAccepted: line.accepted,
            quantityRejected: line.rejected,
            baseQuantity: base,
            unitCost: cost,
            rejectionReason: cmp(line.rejected, "0") > 0 ? line.reason : null,
          });
        }

        await tx.insert(goodsReceiptItems).values(itemRows);

        for (const { id, onHand } of stock.values()) {
          await tx
            .update(inventories)
            .set({ quantityOnHand: onHand })
            .where(eq(inventories.id, id));
        }

        let complete = true;
        let anyReceived = false;

        for (const item of items.values()) {
          const received = toScale(add(item.quantityReceived, takenNow.get(item.id) ?? "0"), 3);

          if (takenNow.has(item.id)) {
            await tx
              .update(purchaseOrderItems)
              .set({ quantityReceived: received })
              .where(eq(purchaseOrderItems.id, item.id));
          }

          complete &&= cmp(received, item.quantityOrdered) >= 0;
          anyReceived ||= cmp(received, "0") > 0;
        }

        const orderStatus = complete
          ? "FULLY_RECEIVED"
          : anyReceived
            ? "PARTIALLY_RECEIVED"
            : order.status;

        if (orderStatus !== order.status) {
          await tx
            .update(purchaseOrders)
            .set({ status: orderStatus })
            .where(eq(purchaseOrders.id, order.id));
        }

        await recordAudit(tx, {
          userId: user.id,
          branchId: order.branchId,
          action: "GOODS_RECEIPT_POSTED",
          entityType: "goods_receipt",
          entityId: receiptId,
          oldValues: { orderStatus: order.status },
          newValues: {
            receiptNumber,
            purchaseOrderId: order.id,
            supplierInvoiceNumber: receipt.invoice,
            lines: itemRows.length,
            orderStatus,
          },
          ...meta,
        });

        return { receiptId, receiptNumber, orderStatus };
      },
      { isolationLevel: "read committed" },
    );
  } catch (error) {
    throw isDuplicateEntry(error) ? duplicateReceipt() : error;
  }
}

/** The receipts posted against an order, oldest first. The caller has already checked the order is visible. */
export async function listReceipts(orderId) {
  return await db
    .select({
      id: goodsReceipts.id,
      receiptNumber: goodsReceipts.receiptNumber,
      supplierInvoiceNumber: goodsReceipts.supplierInvoiceNumber,
      receivedAt: goodsReceipts.receivedAt,
      status: goodsReceipts.status,
    })
    .from(goodsReceipts)
    .where(eq(goodsReceipts.purchaseOrderId, orderId))
    .orderBy(asc(goodsReceipts.receivedAt), asc(goodsReceipts.receiptNumber));
}
