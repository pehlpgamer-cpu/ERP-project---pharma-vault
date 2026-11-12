import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { resetDatabase } from "../../helpers/db.js";
import { makeBranch, makeProduct, makeUser } from "../../helpers/factories.js";
import { goodsReceiptItems } from "../../../app/models/goods-receipt-items.js";
import { goodsReceipts } from "../../../app/models/goods-receipts.js";
import { purchaseOrderItems } from "../../../app/models/purchase-order-items.js";
import { purchaseOrders } from "../../../app/models/purchase-orders.js";
import { suppliers } from "../../../app/models/suppliers.js";

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return String(error.cause?.message ?? error.message);
  }

  return null;
}

async function makeOrder() {
  const branch = await makeBranch();
  const user = await makeUser({ branchId: branch.id });
  const { product, units } = await makeProduct({
    units: [{ name: "Box", factor: "100", base: false }],
  });
  const supplierId = randomUUID();
  const orderId = randomUUID();
  const itemId = randomUUID();

  await db.insert(suppliers).values({ id: supplierId, code: "SUP-1", name: "Acme Pharma" });
  await db.insert(purchaseOrders).values({
    id: orderId,
    poNumber: "PO-1",
    branchId: branch.id,
    supplierId,
    createdBy: user.id,
  });
  await db.insert(purchaseOrderItems).values({
    id: itemId,
    purchaseOrderId: orderId,
    productId: product.id,
    productUnitId: units[0].id,
    conversionFactor: "100",
    quantityOrdered: "10",
    unitCost: "5.0000",
    lineTotal: "50.00",
  });

  return { branch, user, product, orderId, itemId };
}

test.group("purchasing tables", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a purchase order line must order a positive quantity and cannot be over-received", async ({
    expect,
  }) => {
    const { orderId, product, itemId } = await makeOrder();
    const bad = await refusal(
      db.insert(purchaseOrderItems).values({
        purchaseOrderId: orderId,
        productId: product.id,
        productUnitId: randomUUID(),
        conversionFactor: "1",
        quantityOrdered: "0",
        unitCost: "1",
        lineTotal: "0",
      }),
    );
    const over = await refusal(
      db
        .update(purchaseOrderItems)
        .set({ quantityReceived: "11" })
        .where(eq(purchaseOrderItems.id, itemId)),
    );

    expect(bad).not.toBeNull();
    expect(over).toContain("chk_po_items_quantities");
    expect(itemId).toBeTruthy();
  });

  test("a receipt line must balance received = accepted + rejected, and one invoice is received once", async ({
    expect,
  }) => {
    const { orderId, branch, user, product, itemId } = await makeOrder();
    const receiptId = randomUUID();
    const receipt = {
      purchaseOrderId: orderId,
      branchId: branch.id,
      supplierInvoiceNumber: "INV-1",
      receivedAt: new Date(),
      receivedBy: user.id,
    };

    await db.insert(goodsReceipts).values({ id: receiptId, receiptNumber: "GR-1", ...receipt });

    const duplicate = await refusal(
      db.insert(goodsReceipts).values({ receiptNumber: "GR-2", ...receipt }),
    );
    const unbalanced = await refusal(
      db.insert(goodsReceiptItems).values({
        goodsReceiptId: receiptId,
        purchaseOrderItemId: itemId,
        productId: product.id,
        quantityReceived: "10",
        quantityAccepted: "8",
        quantityRejected: "1",
        baseQuantity: "800",
        unitCost: "0.0500",
      }),
    );

    expect(duplicate).toContain("uq_goods_receipts_invoice");
    expect(unbalanced).toContain("chk_receipt_items_quantities");
  });
});
