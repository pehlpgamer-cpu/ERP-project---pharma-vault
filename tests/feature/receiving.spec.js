import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { goodsReceiptItems } from "../../app/models/goods-receipt-items.js";
import { goodsReceipts } from "../../app/models/goods-receipts.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approvePurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
} from "../../app/services/purchasing/purchaseOrders.js";
import { postReceipt } from "../../app/services/purchasing/receiving.js";
import { createSupplier } from "../../app/services/purchasing/suppliers.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct } from "../helpers/factories.js";

const NOW = new Date("2026-11-12T02:00:00Z");
const LATER = new Date("2026-11-13T02:00:00Z");

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

// A SENT order for 10 boxes (100 tablets each) at 250.50 a box, in MAIN.
async function setup({ stocked = false } = {}) {
  const branch = await makeBranch({ code: "MAIN" });
  const other = await makeBranch({ code: "NORTH" });
  const clerk = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const manager = await makeAuthUser({ branchId: branch.id, permissions: ROLE_PERMISSIONS.admin });
  const stranger = await makeAuthUser({
    branchId: other.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const supplier = await createSupplier(clerk, { code: "ACME", name: "Acme Pharma" });
  const stock = await makeProduct({
    branchId: branch.id,
    units: [
      { name: "Tablet", factor: "1", base: true },
      { name: "Box", factor: "100" },
    ],
    batches: stocked ? [{ quantity: "50", batchNumber: "OLD" }] : [],
  });
  const ctx = { branch, clerk, manager, stranger, supplier, ...stock };

  ctx.orderId = await sentOrder(ctx);

  return ctx;
}

async function sentOrder(ctx, quantity = "10", cost = "250.5") {
  const { id } = await createPurchaseOrder(
    ctx.clerk,
    {
      supplierId: ctx.supplier.id,
      lines: [{ productUnitId: ctx.units[1].id, quantity, unitCost: cost }],
    },
    { now: NOW },
  );

  await submitPurchaseOrder(ctx.clerk, id);
  await approvePurchaseOrder(ctx.manager, id);
  await sendPurchaseOrder(ctx.clerk, id);

  return id;
}

async function itemId(ctx) {
  return (await getPurchaseOrder(ctx.manager, ctx.orderId)).lines[0].id;
}

const receipt = (lineId, overrides, lines) => {
  return {
    supplierInvoiceNumber: "INV-1",
    lines: lines ?? [
      {
        purchaseOrderItemId: lineId,
        batchNumber: "LOT-A",
        expirationDate: "2028-01-31",
        quantityAccepted: "9",
        quantityRejected: "1",
        rejectionReason: "crushed box",
      },
    ],
    ...overrides,
  };
};

const stockOf = async (ctx) => {
  const [row] = await db
    .select()
    .from(inventories)
    .where(eq(inventories.productId, ctx.product.id));

  return row?.quantityOnHand ?? null;
};

test.group("goods receiving", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a partial receipt converts accepted boxes to tablets, books a batch and a movement, and leaves the order partly received", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);
    const result = await postReceipt(ctx.clerk, ctx.orderId, receipt(line), { now: NOW });
    const [batch] = await db.select().from(inventoryBatches);
    const [movement] = await db.select().from(inventoryMovements);
    const [item] = await db.select().from(goodsReceiptItems);
    const [header] = await db.select().from(goodsReceipts);
    const { order, lines } = await getPurchaseOrder(ctx.clerk, ctx.orderId);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "GOODS_RECEIPT_POSTED"));

    expect(result).toMatchObject({
      receiptNumber: "GR-MAIN-20261112-0001",
      orderStatus: "PARTIALLY_RECEIVED",
    });
    expect(batch).toMatchObject({
      batchNumber: "LOT-A",
      quantityReceived: "900.000",
      quantityAvailable: "900.000",
      unitCost: "2.5050",
      status: "ACTIVE",
      branchId: ctx.branch.id,
      productId: ctx.product.id,
    });
    expect(movement).toMatchObject({
      movementType: "PURCHASE_RECEIVED",
      referenceType: "goods_receipt",
      referenceId: header.id,
      quantityChange: "900.000",
      quantityBefore: "0.000",
      quantityAfter: "900.000",
      performedBy: ctx.clerk.id,
    });
    expect(await stockOf(ctx)).toBe("900.000");
    expect(item).toMatchObject({
      quantityReceived: "10.000",
      quantityAccepted: "9.000",
      quantityRejected: "1.000",
      baseQuantity: "900.000",
      inventoryBatchId: batch.id,
      rejectionReason: "crushed box",
    });
    expect(header).toMatchObject({ status: "POSTED", supplierInvoiceNumber: "INV-1" });
    expect(lines[0].quantityReceived).toBe("9.000");
    expect(order.status).toBe("PARTIALLY_RECEIVED");
    expect(audit.entityId).toBe(header.id);
  });

  test("the remaining box completes the order, adds to existing stock, and the order can then be closed", async ({
    expect,
  }) => {
    const ctx = await setup({ stocked: true });

    const line = await itemId(ctx);

    await postReceipt(ctx.clerk, ctx.orderId, receipt(line), { now: NOW });
    await postReceipt(
      ctx.clerk,
      ctx.orderId,
      receipt(line, { supplierInvoiceNumber: "INV-2" }, [
        {
          purchaseOrderItemId: line,
          batchNumber: "LOT-B",
          expirationDate: "2029-06-30",
          manufacturingDate: "2026-01-01",
          quantityAccepted: "1",
        },
      ]),
      { now: LATER },
    );

    const batches = await db.select().from(inventoryBatches);
    const { order } = await getPurchaseOrder(ctx.clerk, ctx.orderId);

    await closePurchaseOrder(ctx.clerk, ctx.orderId);

    expect(await stockOf(ctx)).toBe("1050.000");
    expect(
      batches
        .map((batch) => {
          return batch.batchNumber;
        })
        .sort(),
    ).toEqual(["LOT-A", "LOT-B", "OLD"]);
    expect(order.status).toBe("FULLY_RECEIVED");
    expect((await getPurchaseOrder(ctx.clerk, ctx.orderId)).order.status).toBe("CLOSED");
  });

  test("one order line split over two manufacturer batches makes two batches", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);
    const base = { purchaseOrderItemId: line, expirationDate: "2028-01-31" };

    await postReceipt(
      ctx.clerk,
      ctx.orderId,
      receipt(line, {}, [
        { ...base, batchNumber: "L1", quantityAccepted: "4" },
        { ...base, batchNumber: "L2", expirationDate: "2027-05-31", quantityAccepted: "6" },
      ]),
      { now: NOW },
    );

    const batches = await db.select().from(inventoryBatches);

    expect(batches).toHaveLength(2);
    expect(await stockOf(ctx)).toBe("1000.000");
    expect((await getPurchaseOrder(ctx.clerk, ctx.orderId)).order.status).toBe("FULLY_RECEIVED");
  });

  test("bad input is refused with a message per field and nothing is booked", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);
    const good = { purchaseOrderItemId: line, batchNumber: "L1", expirationDate: "2028-01-31" };
    const attempt = async (lines, overrides) => {
      return await failure(
        postReceipt(ctx.clerk, ctx.orderId, receipt(line, overrides, lines), { now: NOW }),
      );
    };
    const paths = (error) => {
      return error.details.map((detail) => {
        return detail.path;
      });
    };

    const over = await attempt([{ ...good, quantityAccepted: "11" }]);
    const split = await attempt([
      { ...good, quantityAccepted: "6" },
      { ...good, batchNumber: "L2", quantityAccepted: "5" },
    ]);
    const expired = await attempt([
      { ...good, expirationDate: "2026-11-12", quantityAccepted: "1" },
    ]);
    const noBatch = await attempt([{ ...good, batchNumber: " ", quantityAccepted: "1" }]);
    const noReason = await attempt([{ ...good, quantityAccepted: "1", quantityRejected: "1" }]);
    const nothing = await attempt([{ purchaseOrderItemId: line, quantityAccepted: "0" }, {}]);
    const noInvoice = await attempt(undefined, { supplierInvoiceNumber: " " });
    const foreign = await attempt([
      { ...good, quantityAccepted: "1" },
      {
        ...good,
        purchaseOrderItemId: "00000000-0000-4000-8000-000000000000",
        quantityAccepted: "1",
      },
    ]);
    const datesBackwards = await attempt([
      { ...good, manufacturingDate: "2029-01-01", quantityAccepted: "1" },
    ]);

    expect(paths(over)).toEqual(["lines.0.quantityAccepted"]);
    expect(paths(split)).toEqual(["lines.1.quantityAccepted"]);
    expect(paths(expired)).toEqual(["lines.0.expirationDate"]);
    expect(paths(noBatch)).toEqual(["lines.0.batchNumber"]);
    expect(paths(noReason)).toEqual(["lines.0.rejectionReason"]);
    expect(paths(nothing)).toEqual(["lines"]);
    expect(paths(noInvoice)).toEqual(["supplierInvoiceNumber"]);
    expect(paths(foreign)).toEqual(["lines.1.purchaseOrderItemId"]);
    expect(paths(datesBackwards)).toEqual(["lines.0.manufacturingDate"]);
    expect(await db.select().from(goodsReceipts)).toHaveLength(0);
    expect(await db.select().from(inventoryBatches)).toHaveLength(0);
    expect(await stockOf(ctx)).toBeNull();
  });

  test("only a sent or partly received order in the clerk's own branch can be received", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);
    const draft = await createPurchaseOrder(
      ctx.clerk,
      {
        supplierId: ctx.supplier.id,
        lines: [{ productUnitId: ctx.units[1].id, quantity: "1", unitCost: "1" }],
      },
      { now: NOW },
    );
    const draftLine = (await getPurchaseOrder(ctx.clerk, draft.id)).lines[0].id;
    const notSent = await failure(
      postReceipt(ctx.clerk, draft.id, receipt(draftLine), { now: NOW }),
    );
    const elsewhere = await failure(
      postReceipt(ctx.stranger, ctx.orderId, receipt(line), { now: NOW }),
    );
    const clerkWithoutRight = { ...ctx.clerk, permissions: ["purchasing.view"] };
    const denied = await failure(
      postReceipt(clerkWithoutRight, ctx.orderId, receipt(line), { now: NOW }),
    );
    const unknown = await failure(postReceipt(ctx.clerk, "nope", receipt(line), { now: NOW }));

    expect([notSent.status, notSent.code]).toEqual([409, "po_state"]);
    expect(elsewhere.status).toBe(404);
    expect(denied.status).toBe(403);
    expect(unknown.status).toBe(404);
    expect(await db.select().from(goodsReceipts)).toHaveLength(0);
  });

  test("posting the same supplier invoice twice creates nothing the second time", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);

    await postReceipt(ctx.clerk, ctx.orderId, receipt(line), { now: NOW });

    const again = await failure(postReceipt(ctx.clerk, ctx.orderId, receipt(line), { now: NOW }));

    expect([again.status, again.code]).toEqual([409, "receipt_duplicate"]);
    expect(await stockOf(ctx)).toBe("900.000");
    expect(await db.select().from(goodsReceipts)).toHaveLength(1);
  });

  test("two clerks posting the full delivery at once: stock is booked once", async ({ expect }) => {
    const ctx = await setup();

    const line = await itemId(ctx);
    const full = (invoice) => {
      return receipt(line, { supplierInvoiceNumber: invoice }, [
        {
          purchaseOrderItemId: line,
          batchNumber: `LOT-${invoice}`,
          expirationDate: "2028-01-31",
          quantityAccepted: "10",
        },
      ]);
    };
    const results = await Promise.allSettled([
      postReceipt(ctx.clerk, ctx.orderId, full("INV-A"), { now: NOW }),
      postReceipt(ctx.manager, ctx.orderId, full("INV-B"), { now: NOW }),
    ]);
    const failed = results.filter((result) => {
      return result.status === "rejected";
    });

    expect(failed).toHaveLength(1);
    expect([failed[0].reason.status, failed[0].reason.code]).toEqual([409, "po_state"]);
    expect(await stockOf(ctx)).toBe("1000.000");
    expect(await db.select().from(inventoryBatches)).toHaveLength(1);
    expect((await getPurchaseOrder(ctx.clerk, ctx.orderId)).lines[0].quantityReceived).toBe(
      "10.000",
    );
  });

  test("a delivery that is wholly rejected books no stock and leaves the order status alone", async ({
    expect,
  }) => {
    const ctx = await setup();

    const line = await itemId(ctx);

    await postReceipt(
      ctx.clerk,
      ctx.orderId,
      receipt(line, {}, [
        { purchaseOrderItemId: line, quantityRejected: "10", rejectionReason: "wrong product" },
      ]),
      { now: NOW },
    );

    expect(await stockOf(ctx)).toBeNull();
    expect(await db.select().from(inventoryBatches)).toHaveLength(0);
    expect((await getPurchaseOrder(ctx.clerk, ctx.orderId)).order.status).toBe("SENT");
    expect(await db.select().from(goodsReceiptItems)).toHaveLength(1);
  });

  test("impossible dates, too many rows and quantities too big for stock are refused, never a 500", async ({
    expect,
  }) => {
    const ctx = await setup();
    const line = await itemId(ctx);
    const good = { purchaseOrderItemId: line, batchNumber: "L1", quantityAccepted: "1" };
    const failed = async (lines) => {
      return await failure(
        postReceipt(ctx.clerk, ctx.orderId, receipt(line, undefined, lines), { now: NOW }),
      );
    };
    const paths = (error) => {
      return error.details.map((detail) => {
        return detail.path;
      });
    };

    const badDay = await failed([{ ...good, expirationDate: "2028-13-01" }]);
    const zeroDay = await failed([{ ...good, expirationDate: "0000-00-00" }]);
    const badMade = await failed([
      { ...good, expirationDate: "2028-01-31", manufacturingDate: "2020-01-32" },
    ]);
    const tooMany = await failed(
      Array.from({ length: 201 }, () => {
        return { ...good, expirationDate: "2028-01-31" };
      }),
    );

    expect(paths(badDay)).toEqual(["lines.0.expirationDate"]);
    expect(paths(zeroDay)).toEqual(["lines.0.expirationDate"]);
    expect(paths(badMade)).toEqual(["lines.0.manufacturingDate"]);
    expect(paths(tooMany)).toEqual(["lines"]);

    const huge = await sentOrder(ctx, "99999999999", "0");
    const hugeLine = (await getPurchaseOrder(ctx.manager, huge)).lines[0].id;
    const overflow = await failure(
      postReceipt(
        ctx.clerk,
        huge,
        receipt(hugeLine, undefined, [
          {
            purchaseOrderItemId: hugeLine,
            batchNumber: "H1",
            expirationDate: "2028-01-31",
            quantityAccepted: "99999999999",
          },
        ]),
        { now: NOW },
      ),
    );

    expect(paths(overflow)).toEqual(["lines.0.quantityAccepted"]);
    expect(await db.select().from(goodsReceipts)).toHaveLength(0);
  });
});
