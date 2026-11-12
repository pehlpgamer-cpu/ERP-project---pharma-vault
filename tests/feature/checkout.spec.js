import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { asc, eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { cashRegisterSessions } from "../../app/models/cash-register-sessions.js";
import { cashTransactions } from "../../app/models/cash-transactions.js";
import { documentSequences } from "../../app/models/document-sequences.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { saleItemBatches } from "../../app/models/sale-item-batches.js";
import { saleItems } from "../../app/models/sale-items.js";
import { salePayments } from "../../app/models/sale-payments.js";
import { sales } from "../../app/models/sales.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { createSale } from "../../app/services/sales/checkout.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeCustomer,
  makeOpenSession,
  makeProduct,
  makeRegister,
  makeStock,
  makeUser,
} from "../helpers/factories.js";

const NOW = new Date("2026-11-12T03:00:00Z"); // 11:00 on 2026-11-12 in Asia/Manila
const TODAY = "2026-11-12";

const line = (unit, quantity) => {
  return { productUnitId: unit.id, quantity };
};
const cash = (amount) => {
  return { method: "CASH", amount, reference: null };
};
const electronic = (method, amount, reference) => {
  return { method, amount, reference };
};

// MAIN branch, a cashier with an open register session, and one product in three units
// (Tablet 3.50, Strip of 10 at 30.00, Box of 100 at 250.00) with one batch costing 1.20 a tablet.
async function shop({ stock = [{ quantity: "1000.000", unitCost: "1.2000" }], product = {} } = {}) {
  const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
  const cashier = await makeUser({
    branchId: branch.id,
    roleName: "cashier-checkout",
    permissions: ROLE_PERMISSIONS.cashier,
    name: "Ana Reyes",
  });
  const register = await makeRegister({ branchId: branch.id });
  const session = await makeOpenSession({ registerId: register.id, cashierId: cashier.id });
  const stocked = await makeProduct({
    branchId: branch.id,
    name: "Paracetamol 500 mg Tablet",
    genericName: "Paracetamol",
    units: [
      { name: "Tablet", factor: "1", base: true, price: "3.5000" },
      { name: "Strip", factor: "10", price: "30.0000" },
      { name: "Box", factor: "100", price: "250.0000" },
    ],
    batches: stock,
    ...product,
  });

  return {
    branch,
    cashier,
    user: await loadAuthUser(cashier.id),
    register,
    session,
    product: stocked.product,
    tablet: stocked.units[0],
    strip: stocked.units[1],
    box: stocked.units[2],
    batches: stocked.batches,
  };
}

// Another cashier of the same branch with a register session of their own.
async function colleague(ctx) {
  const cashier = await makeUser({
    branchId: ctx.branch.id,
    roleName: "cashier-checkout",
    permissions: ROLE_PERMISSIONS.cashier,
  });
  const register = await makeRegister({ branchId: ctx.branch.id });
  const session = await makeOpenSession({ registerId: register.id, cashierId: cashier.id });

  return { cashier, user: await loadAuthUser(cashier.id), register, session };
}

function sell(ctx, input, key = randomUUID(), options = {}) {
  return createSale(ctx.user, { customerId: null, ...input }, key, { now: NOW, ...options });
}

const batchRow = async (id) => {
  const [row] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, id));

  return row;
};

// Every table a checkout writes, so "nothing changed" is one comparison.
async function snapshot() {
  return {
    sales: await db.select({ id: sales.id }).from(sales),
    items: await db.select({ id: saleItems.id }).from(saleItems),
    itemBatches: await db.select({ id: saleItemBatches.id }).from(saleItemBatches),
    payments: await db.select({ id: salePayments.id }).from(salePayments),
    movements: await db.select({ id: inventoryMovements.id }).from(inventoryMovements),
    cash: await db.select({ id: cashTransactions.id }).from(cashTransactions),
    audits: await db.select({ id: auditLogs.id }).from(auditLogs),
    sequences: await db.select().from(documentSequences),
    batches: await db
      .select({
        id: inventoryBatches.id,
        quantityAvailable: inventoryBatches.quantityAvailable,
        status: inventoryBatches.status,
      })
      .from(inventoryBatches)
      .orderBy(asc(inventoryBatches.id)),
    inventories: await db
      .select({ id: inventories.id, quantityOnHand: inventories.quantityOnHand })
      .from(inventories)
      .orderBy(asc(inventories.id)),
  };
}

test.group("checkout: a completed sale", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("two strips paid in cash write the sale, the stock and the ledgers together", async ({
    expect,
  }) => {
    const ctx = await shop();
    const key = randomUUID();
    const steps = [];

    const result = await sell(
      ctx,
      { items: [line(ctx.strip, "2.000")], payments: [cash("100.00")] },
      key,
      {
        onStep: (step) => {
          steps.push(step);
        },
      },
    );

    expect(result).toEqual({ saleId: expect.any(String), replayed: false });
    expect(steps).toEqual(["allocated", "sale-inserted", "ledger-written"]);

    const [sale] = await db.select().from(sales);
    expect(sale).toMatchObject({
      id: result.saleId,
      invoiceNumber: "MAIN-20261112-0001",
      status: "COMPLETED",
      branchId: ctx.branch.id,
      cashierId: ctx.cashier.id,
      cashRegisterSessionId: ctx.session.id,
      customerId: null,
      subtotal: "60.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      totalAmount: "60.00",
      amountPaid: "100.00",
      changeAmount: "40.00",
      idempotencyKey: key,
    });
    expect(sale.transactionDate.getTime()).toBe(NOW.getTime());

    expect(await batchRow(ctx.batches[0].id)).toMatchObject({
      quantityAvailable: "980.000",
      status: "ACTIVE",
    });
    const [inventory] = await db.select().from(inventories);
    expect(inventory.quantityOnHand).toBe("980.000");

    const [movement] = await db.select().from(inventoryMovements);
    expect(movement).toMatchObject({
      branchId: ctx.branch.id,
      productId: ctx.product.id,
      inventoryBatchId: ctx.batches[0].id,
      movementType: "SALE",
      referenceType: "sale",
      referenceId: result.saleId,
      quantityChange: "-20.000",
      quantityBefore: "1000.000",
      quantityAfter: "980.000",
      unitCost: "1.2000",
      performedBy: ctx.cashier.id,
    });

    const [item] = await db.select().from(saleItems);
    expect(item).toMatchObject({
      saleId: result.saleId,
      productId: ctx.product.id,
      productUnitId: ctx.strip.id,
      productNameSnapshot: "Paracetamol 500 mg Tablet",
      genericNameSnapshot: "Paracetamol",
      quantity: "2.000",
      baseQuantity: "20.000",
      unitPrice: "30.0000",
      unitCost: "12.0000",
      subtotal: "60.00",
      totalAmount: "60.00",
    });
    const [itemBatch] = await db.select().from(saleItemBatches);
    expect(itemBatch).toMatchObject({
      saleItemId: item.id,
      inventoryBatchId: ctx.batches[0].id,
      quantity: "20.000",
      unitCost: "1.2000",
    });

    const [payment] = await db.select().from(salePayments);
    expect(payment).toMatchObject({
      saleId: result.saleId,
      paymentMethod: "CASH",
      amount: "100.00",
      referenceNumber: null,
      paymentStatus: "PAID",
    });
    expect(payment.paidAt.getTime()).toBe(NOW.getTime());

    const [ledger] = await db.select().from(cashTransactions);
    expect(ledger).toMatchObject({
      cashRegisterSessionId: ctx.session.id,
      transactionType: "CASH_SALE",
      amount: "60.00",
      referenceType: "sale",
      referenceId: result.saleId,
      performedBy: ctx.cashier.id,
    });

    const [audit] = await db.select().from(auditLogs);
    expect(audit).toMatchObject({
      action: "SALE_COMPLETED",
      entityType: "sale",
      entityId: result.saleId,
      userId: ctx.cashier.id,
      branchId: ctx.branch.id,
    });
    expect(audit.newValues).toMatchObject({ invoiceNumber: "MAIN-20261112-0001", total: "60.00" });
  });

  test("invoice numbers count per branch and business day, without gaps", async ({ expect }) => {
    const ctx = await shop();
    const input = { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] };

    await sell(ctx, input);
    await sell(ctx, input);
    // 2026-11-12T16:00:00Z is already 00:00 on Nov 13 in Asia/Manila
    await sell(ctx, input, randomUUID(), { now: new Date("2026-11-12T16:00:00Z") });
    await sell(ctx, input, randomUUID(), { now: new Date("2026-11-13T03:00:00Z") });
    const rows = await db
      .select()
      .from(sales)
      .orderBy(asc(sales.createdAt), asc(sales.invoiceNumber));
    const sequences = await db
      .select()
      .from(documentSequences)
      .orderBy(asc(documentSequences.scope));

    expect(
      rows
        .map((row) => {
          return row.invoiceNumber;
        })
        .sort(),
    ).toEqual([
      "MAIN-20261112-0001",
      "MAIN-20261112-0002",
      "MAIN-20261113-0001",
      "MAIN-20261113-0002",
    ]);
    expect(sequences).toMatchObject([
      { scope: "invoice:MAIN:20261112", lastValue: 2 },
      { scope: "invoice:MAIN:20261113", lastValue: 2 },
    ]);
  });

  test("line amounts are rounded half away from zero to two places", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, { items: [line(ctx.tablet, "0.333")], payments: [cash("5.00")] });

    const [item] = await db.select().from(saleItems);
    const [sale] = await db.select().from(sales);
    expect(item).toMatchObject({ baseQuantity: "0.333", subtotal: "1.17", totalAmount: "1.17" });
    expect(sale).toMatchObject({ totalAmount: "1.17", changeAmount: "3.83" });
  });

  test("a customer can be attached to the sale", async ({ expect }) => {
    const ctx = await shop();
    const customer = await makeCustomer();

    await sell(ctx, {
      items: [line(ctx.tablet, "1.000")],
      payments: [cash("10.00")],
      customerId: customer.id,
    });

    const [sale] = await db.select().from(sales);
    expect(sale.customerId).toBe(customer.id);
  });

  test("units convert to base quantity: two boxes are 200 tablets", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, { items: [line(ctx.box, "2.000")], payments: [cash("500.00")] });

    const [item] = await db.select().from(saleItems);
    expect(item).toMatchObject({ quantity: "2.000", baseQuantity: "200.000", subtotal: "500.00" });
    expect((await batchRow(ctx.batches[0].id)).quantityAvailable).toBe("800.000");
  });

  test("two lines of one product in different units share the stock", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, {
      items: [line(ctx.tablet, "5.000"), line(ctx.strip, "1.000")],
      payments: [cash("50.00")],
    });

    const [inventory] = await db.select().from(inventories);
    expect(inventory.quantityOnHand).toBe("985.000");
    expect(await db.select().from(saleItems)).toHaveLength(2);
    expect(await db.select().from(inventoryMovements)).toHaveLength(2);
  });
});

test.group("checkout: payments", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a split payment with no change keeps only the cash in the drawer ledger", async ({
    expect,
  }) => {
    const ctx = await shop();

    await sell(ctx, {
      items: [line(ctx.strip, "6.000")],
      payments: [cash("100.00"), electronic("GCASH", "80.00", "GC-1")],
    });

    const [sale] = await db.select().from(sales);
    const payments = await db.select().from(salePayments);
    const [ledger] = await db.select().from(cashTransactions);
    expect(sale).toMatchObject({
      totalAmount: "180.00",
      amountPaid: "180.00",
      changeAmount: "0.00",
    });
    expect(
      payments
        .map((payment) => {
          return [payment.paymentMethod, payment.amount, payment.referenceNumber];
        })
        .sort(),
    ).toEqual([
      ["CASH", "100.00", null],
      ["GCASH", "80.00", "GC-1"],
    ]);
    expect(ledger.amount).toBe("100.00");
  });

  test("over-tendered cash is given back as change out of the cash only", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, {
      items: [line(ctx.strip, "6.000")],
      payments: [cash("150.00"), electronic("GCASH", "100.00", "GC-2")],
    });

    const [sale] = await db.select().from(sales);
    const [ledger] = await db.select().from(cashTransactions);
    expect(sale).toMatchObject({ amountPaid: "250.00", changeAmount: "70.00" });
    expect(ledger.amount).toBe("80.00");
  });

  test("an electronic-only payment writes no cash ledger row", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, {
      items: [line(ctx.strip, "2.000")],
      payments: [electronic("CARD", "60.00", "AUTH-9")],
    });

    expect(await db.select().from(cashTransactions)).toHaveLength(0);
    expect((await db.select().from(sales))[0].changeAmount).toBe("0.00");
  });

  test("exact cash leaves no change", async ({ expect }) => {
    const ctx = await shop();

    await sell(ctx, { items: [line(ctx.strip, "2.000")], payments: [cash("60.00")] });

    expect((await db.select().from(sales))[0].changeAmount).toBe("0.00");
    expect((await db.select().from(cashTransactions))[0].amount).toBe("60.00");
  });

  test("an underpayment, electronic overpayment or missing reference is payment_invalid and changes nothing", async ({
    expect,
  }) => {
    const ctx = await shop();
    const items = [line(ctx.strip, "6.000")]; // 180.00
    const before = await snapshot();

    for (const payments of [
      [cash("100.00")],
      [electronic("GCASH", "200.00", "GC-3")],
      [electronic("GCASH", "100.00", "GC-4"), electronic("CARD", "100.00", "AUTH-1")],
      [cash("100.00"), electronic("GCASH", "80.00", null)],
      [cash("100.00"), electronic("GCASH", "80.00", "   ")],
      [cash("100.00"), electronic("GCASH", "80.00", "")],
    ]) {
      await expect(sell(ctx, { items, payments })).rejects.toMatchObject({
        status: 422,
        code: "payment_invalid",
      });
    }

    expect(await snapshot()).toEqual(before);
  });
});

test.group("checkout: first-expiry-first-out", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("250 tablets come from the earliest-expiring batches, whatever the insert order", async ({
    expect,
  }) => {
    const ctx = await shop({
      stock: [
        {
          quantity: "150.000",
          expirationDate: "2027-07-31",
          unitCost: "3.0000",
          receivedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          quantity: "100.000",
          expirationDate: "2027-03-31",
          unitCost: "2.0000",
          receivedAt: new Date("2026-02-01T00:00:00Z"),
        },
        {
          quantity: "200.000",
          expirationDate: "2027-01-31",
          unitCost: "1.0000",
          receivedAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    });
    const [late, middle, early] = ctx.batches;

    await sell(ctx, { items: [line(ctx.tablet, "250.000")], payments: [cash("1000.00")] });

    const [item] = await db.select().from(saleItems);
    const used = await db
      .select()
      .from(saleItemBatches)
      .where(eq(saleItemBatches.saleItemId, item.id));
    const byBatch = Object.fromEntries(
      used.map((row) => {
        return [row.inventoryBatchId, row];
      }),
    );
    expect(used).toHaveLength(2);
    expect(byBatch[early.id]).toMatchObject({ quantity: "200.000", unitCost: "1.0000" });
    expect(byBatch[middle.id]).toMatchObject({ quantity: "50.000", unitCost: "2.0000" });
    expect(item.baseQuantity).toBe("250.000");
    // (200 x 1.00 + 50 x 2.00) / 250 tablets
    expect(item.unitCost).toBe("1.2000");
    expect(await batchRow(early.id)).toMatchObject({
      quantityAvailable: "0.000",
      status: "DEPLETED",
    });
    expect(await batchRow(middle.id)).toMatchObject({
      quantityAvailable: "50.000",
      status: "ACTIVE",
    });
    expect(await batchRow(late.id)).toMatchObject({
      quantityAvailable: "150.000",
      status: "ACTIVE",
    });

    const movements = await db.select().from(inventoryMovements);
    expect(
      movements
        .map((row) => {
          return [row.inventoryBatchId, row.quantityChange, row.quantityBefore, row.quantityAfter];
        })
        .sort(),
    ).toEqual(
      [
        [early.id, "-200.000", "200.000", "0.000"],
        [middle.id, "-50.000", "100.000", "50.000"],
      ].sort(),
    );
  });

  test("a batch without an expiry date is used after every dated batch", async ({ expect }) => {
    const ctx = await shop({
      stock: [
        { quantity: "5.000", expirationDate: null },
        { quantity: "5.000", expirationDate: "2027-01-31" },
      ],
    });
    const [undated, dated] = ctx.batches;

    await sell(ctx, { items: [line(ctx.tablet, "7.000")], payments: [cash("30.00")] });

    expect((await batchRow(dated.id)).quantityAvailable).toBe("0.000");
    expect((await batchRow(undated.id)).quantityAvailable).toBe("3.000");
  });

  test("an expired, quarantined or recalled batch is never sold", async ({ expect }) => {
    const ctx = await shop({
      stock: [
        { quantity: "100.000", expirationDate: "2026-11-11" },
        { quantity: "100.000", status: "QUARANTINED" },
        { quantity: "100.000", status: "RECALLED" },
        { quantity: "5.000", expirationDate: "2027-06-30" },
      ],
    });
    const before = await snapshot();

    await expect(
      sell(ctx, { items: [line(ctx.tablet, "10.000")], payments: [cash("100.00")] }),
    ).rejects.toMatchObject({
      status: 409,
      code: "insufficient_stock",
      details: [{ productId: ctx.product.id, requested: "10.000", available: "5.000" }],
    });
    expect(await snapshot()).toEqual(before);
  });

  test("a batch expiring today sells, and EXPIRY_BUFFER_DAYS=1 stops it", async ({ expect }) => {
    const ctx = await shop({ stock: [{ quantity: "10.000", expirationDate: TODAY }] });
    const original = process.env.EXPIRY_BUFFER_DAYS;

    try {
      process.env.EXPIRY_BUFFER_DAYS = "1";
      await expect(
        sell(ctx, { items: [line(ctx.tablet, "4.000")], payments: [cash("20.00")] }),
      ).rejects.toMatchObject({ code: "insufficient_stock" });

      delete process.env.EXPIRY_BUFFER_DAYS;
      await sell(ctx, { items: [line(ctx.tablet, "4.000")], payments: [cash("20.00")] });
    } finally {
      if (original === undefined) {
        delete process.env.EXPIRY_BUFFER_DAYS;
      } else {
        process.env.EXPIRY_BUFFER_DAYS = original;
      }
    }

    expect((await batchRow(ctx.batches[0].id)).quantityAvailable).toBe("6.000");
  });

  test("stock of another branch is not for sale", async ({ expect }) => {
    const ctx = await shop({ stock: [{ quantity: "5.000" }] });
    const north = await makeBranch({ code: "NORTH" });
    await makeStock({
      productId: ctx.product.id,
      branchId: north.id,
      batches: [{ quantity: "500.000" }],
    });

    await expect(
      sell(ctx, { items: [line(ctx.tablet, "10.000")], payments: [cash("100.00")] }),
    ).rejects.toMatchObject({ code: "insufficient_stock", details: [{ available: "5.000" }] });
  });

  test("two lines for the same product cannot oversell: 7 + 7 of 10 changes nothing", async ({
    expect,
  }) => {
    const ctx = await shop({ stock: [{ quantity: "10.000" }] });
    const before = await snapshot();

    await expect(
      sell(ctx, {
        items: [line(ctx.tablet, "7.000"), line(ctx.tablet, "7.000")],
        payments: [cash("100.00")],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "insufficient_stock",
      details: [{ productId: ctx.product.id, requested: "14.000", available: "10.000" }],
    });
    expect(await snapshot()).toEqual(before);
  });

  test("two lines for the same product that fit are served one after the other", async ({
    expect,
  }) => {
    const ctx = await shop({ stock: [{ quantity: "10.000" }] });

    await sell(ctx, {
      items: [line(ctx.tablet, "5.000"), line(ctx.tablet, "5.000")],
      payments: [cash("50.00")],
    });

    expect(await batchRow(ctx.batches[0].id)).toMatchObject({
      quantityAvailable: "0.000",
      status: "DEPLETED",
    });
    const movements = await db.select().from(inventoryMovements);
    expect(
      movements
        .map((row) => {
          return [row.quantityBefore, row.quantityAfter];
        })
        .sort(),
    ).toEqual([
      ["10.000", "5.000"],
      ["5.000", "0.000"],
    ]);
    expect((await db.select().from(inventories))[0].quantityOnHand).toBe("0.000");
  });

  test("a product with no inventory row at all is insufficient stock", async ({ expect }) => {
    const ctx = await shop({ stock: [] });

    await expect(
      sell(ctx, { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] }),
    ).rejects.toMatchObject({
      status: 409,
      code: "insufficient_stock",
      details: [{ productId: ctx.product.id, requested: "1.000", available: "0.000" }],
    });
  });
});

test.group("checkout: refusals", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("only OTC products without a prescription requirement can be sold", async ({ expect }) => {
    for (const [classification, requiresPrescription] of [
      ["PRESCRIPTION", true],
      ["OTC", true],
      ["CONTROLLED", true],
      ["OTHER", false],
    ]) {
      await resetDatabase();
      const ctx = await shop({ product: { classification, requiresPrescription } });
      const before = await snapshot();

      await expect(
        sell(ctx, { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] }),
      ).rejects.toMatchObject({ status: 422, code: "prescription_required" });
      expect([classification, await snapshot()]).toEqual([classification, before]);
    }
  });

  test("one Rx line rejects the whole request", async ({ expect }) => {
    const ctx = await shop();
    const rx = await makeProduct({
      branchId: ctx.branch.id,
      name: "Amoxicillin",
      classification: "PRESCRIPTION",
      requiresPrescription: true,
      units: [{ name: "Capsule", factor: "1", base: true, price: "8.0000" }],
      batches: [{ quantity: "50.000" }],
    });
    const before = await snapshot();

    await expect(
      sell(ctx, {
        items: [line(ctx.tablet, "1.000"), line(rx.units[0], "1.000")],
        payments: [cash("100.00")],
      }),
    ).rejects.toMatchObject({ code: "prescription_required" });
    expect(await snapshot()).toEqual(before);
  });

  test("a unit without an effective price is no_price", async ({ expect }) => {
    const ctx = await shop({
      product: { units: [{ name: "Tablet", factor: "1", base: true }] },
    });
    const before = await snapshot();

    await expect(
      sell(ctx, { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] }),
    ).rejects.toMatchObject({ status: 422, code: "no_price" });
    expect(await snapshot()).toEqual(before);
  });

  test("a user without an open register session gets register_closed", async ({ expect }) => {
    const ctx = await shop();
    const before = await snapshot();
    const input = { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] };
    const stranger = await loadAuthUser(
      (
        await makeUser({
          branchId: ctx.branch.id,
          roleName: "cashier-checkout",
          permissions: ROLE_PERMISSIONS.cashier,
        })
      ).id,
    );

    await expect(
      createSale(stranger, { customerId: null, ...input }, randomUUID(), { now: NOW }),
    ).rejects.toMatchObject({ status: 409, code: "register_closed" });

    for (const status of ["CLOSED", "RECONCILIATION_REQUIRED"]) {
      await db
        .update(cashRegisterSessions)
        .set({ status })
        .where(eq(cashRegisterSessions.id, ctx.session.id));

      await expect(sell(ctx, input)).rejects.toMatchObject({
        status: 409,
        code: "register_closed",
      });
    }

    expect(await snapshot()).toEqual(before);
  });

  test("an unknown, inactive or unsellable unit, or an unknown customer, is validation_failed", async ({
    expect,
  }) => {
    const ctx = await shop();
    const hidden = await makeProduct({
      branchId: ctx.branch.id,
      name: "Retired",
      units: [
        { name: "Retired tablet", factor: "1", base: true, price: "5.0000", isActive: false },
        { name: "Bulk", factor: "10", price: "50.0000", canBeSold: false },
      ],
      batches: [{ quantity: "50.000" }],
    });
    const inactiveProduct = await makeProduct({
      branchId: ctx.branch.id,
      name: "Discontinued",
      isActive: false,
      units: [{ name: "Pill", factor: "1", base: true, price: "5.0000" }],
      batches: [{ quantity: "50.000" }],
    });
    const before = await snapshot();
    const payments = [cash("100.00")];

    for (const items of [
      [{ productUnitId: randomUUID(), quantity: "1.000" }],
      [line(hidden.units[0], "1.000")],
      [line(hidden.units[1], "1.000")],
      [line(inactiveProduct.units[0], "1.000")],
    ]) {
      await expect(sell(ctx, { items, payments })).rejects.toMatchObject({
        status: 422,
        code: "validation_failed",
      });
    }

    await expect(
      sell(ctx, { items: [line(ctx.tablet, "1.000")], payments, customerId: randomUUID() }),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(await snapshot()).toEqual(before);
  });
});

test.group("checkout: idempotency and rollback", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("the same key twice returns the stored sale and decrements stock once", async ({
    expect,
  }) => {
    const ctx = await shop();
    const key = randomUUID();
    const input = { items: [line(ctx.strip, "2.000")], payments: [cash("100.00")] };

    const first = await sell(ctx, input, key);
    const afterFirst = await snapshot();
    const second = await sell(ctx, input, key);
    // a different body under the same key still answers with the stored sale
    const third = await sell(ctx, { ...input, items: [line(ctx.strip, "9.000")] }, key);

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ saleId: first.saleId, replayed: true });
    expect(third).toEqual({ saleId: first.saleId, replayed: true });
    expect(await snapshot()).toEqual(afterFirst);
    expect((await batchRow(ctx.batches[0].id)).quantityAvailable).toBe("980.000");
  });

  test("another user with the same key gets idempotency_conflict", async ({ expect }) => {
    const ctx = await shop();
    const other = await colleague(ctx);
    const key = randomUUID();
    const input = { items: [line(ctx.tablet, "1.000")], payments: [cash("10.00")] };
    await sell(ctx, input, key);
    const before = await snapshot();

    await expect(sell(other, input, key)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    });
    expect(await snapshot()).toEqual(before);
  });

  test("a failure at any step rolls everything back and leaves no gap in the numbering", async ({
    expect,
  }) => {
    const ctx = await shop();
    const input = { items: [line(ctx.strip, "2.000")], payments: [cash("100.00")] };
    const before = await snapshot();

    for (const failingStep of ["allocated", "sale-inserted", "ledger-written"]) {
      await expect(
        sell(ctx, input, randomUUID(), {
          onStep: (step) => {
            if (step === failingStep) {
              throw new Error(`boom at ${failingStep}`);
            }
          },
        }),
      ).rejects.toThrow(`boom at ${failingStep}`);
      expect([failingStep, await snapshot()]).toEqual([failingStep, before]);
    }

    await sell(ctx, input);

    expect((await db.select().from(sales))[0].invoiceNumber).toBe("MAIN-20261112-0001");
  });

  test("a deadlock is retried, up to three attempts", async ({ expect }) => {
    const ctx = await shop();
    const input = { items: [line(ctx.strip, "2.000")], payments: [cash("100.00")] };
    const deadlock = () => {
      return Object.assign(new Error("Deadlock found when trying to get lock"), {
        code: "ER_LOCK_DEADLOCK",
      });
    };
    let attempts = 0;

    const result = await sell(ctx, input, randomUUID(), {
      onStep: (step) => {
        if (step === "allocated") {
          attempts += 1;

          if (attempts < 3) {
            throw deadlock();
          }
        }
      },
    });

    expect(attempts).toBe(3);
    expect(result.replayed).toBe(false);
    expect(await db.select().from(sales)).toHaveLength(1);
    expect((await batchRow(ctx.batches[0].id)).quantityAvailable).toBe("980.000");

    const before = await snapshot();
    let tries = 0;

    await expect(
      sell(ctx, input, randomUUID(), {
        onStep: (step) => {
          if (step === "allocated") {
            tries += 1;
            throw deadlock();
          }
        },
      }),
    ).rejects.toMatchObject({ code: "ER_LOCK_DEADLOCK" });
    expect(tries).toBe(3);
    expect(await snapshot()).toEqual(before);
  });
});

test.group("checkout: concurrency", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("two cashiers buying the last 10 units: exactly one sale, the other gets insufficient_stock", async ({
    expect,
  }) => {
    for (let round = 0; round < 5; round += 1) {
      await resetDatabase();
      const ctx = await shop({ stock: [{ quantity: "10.000" }] });
      const other = await colleague(ctx);
      const input = { items: [line(ctx.tablet, "10.000")], payments: [cash("35.00")] };

      const results = await Promise.allSettled([sell(ctx, input), sell(other, input)]);
      const fulfilled = results.filter((result) => {
        return result.status === "fulfilled";
      });
      const rejected = results.filter((result) => {
        return result.status === "rejected";
      });

      expect([round, fulfilled.length, rejected.length]).toEqual([round, 1, 1]);
      expect(rejected[0].reason).toMatchObject({ status: 409, code: "insufficient_stock" });
      expect(await batchRow(ctx.batches[0].id)).toMatchObject({
        quantityAvailable: "0.000",
        status: "DEPLETED",
      });
      expect(await db.select().from(sales)).toHaveLength(1);
      expect((await db.select().from(inventories))[0].quantityOnHand).toBe("0.000");
    }
  });

  test("a double-clicked sale (same key, at once) is one sale and one replay, even for the last units", async ({
    expect,
  }) => {
    for (const quantity of ["1000.000", "10.000"]) {
      for (let round = 0; round < 3; round += 1) {
        await resetDatabase();
        const ctx = await shop({ stock: [{ quantity }] });
        const key = randomUUID();
        const input = { items: [line(ctx.tablet, "10.000")], payments: [cash("35.00")] };

        const results = await Promise.all([sell(ctx, input, key), sell(ctx, input, key)]);

        const flags = results
          .map((result) => {
            return result.replayed;
          })
          .sort();

        expect([quantity, round, flags]).toEqual([quantity, round, [false, true]]);
        expect(results[0].saleId).toBe(results[1].saleId);
        expect(await db.select().from(sales)).toHaveLength(1);
        expect(await db.select().from(inventoryMovements)).toHaveLength(1);
        expect((await batchRow(ctx.batches[0].id)).quantityAvailable).toBe(
          quantity === "10.000" ? "0.000" : "990.000",
        );
      }
    }
  });

  test("many cashiers selling different products at once never deadlock or oversell", async ({
    expect,
  }) => {
    const ctx = await shop({ stock: [{ quantity: "100.000" }] });
    const second = await makeProduct({
      branchId: ctx.branch.id,
      name: "Second product",
      units: [{ name: "Capsule", factor: "1", base: true, price: "2.0000" }],
      batches: [{ quantity: "100.000" }],
    });
    const cashiers = [ctx, await colleague(ctx), await colleague(ctx), await colleague(ctx)];

    const results = await Promise.all(
      cashiers.map((who, index) => {
        // opposite line orders on purpose
        const items =
          index % 2 === 0
            ? [line(ctx.tablet, "5.000"), line(second.units[0], "5.000")]
            : [line(second.units[0], "5.000"), line(ctx.tablet, "5.000")];

        return sell(who, { items, payments: [cash("100.00")] });
      }),
    );

    const onHand = (await db.select().from(inventories))
      .map((row) => {
        return row.quantityOnHand;
      })
      .sort();

    expect(
      results.every((result) => {
        return !result.replayed;
      }),
    ).toBe(true);
    expect(onHand).toEqual(["80.000", "80.000"]);
    expect(await db.select().from(sales)).toHaveLength(4);
  });
});
