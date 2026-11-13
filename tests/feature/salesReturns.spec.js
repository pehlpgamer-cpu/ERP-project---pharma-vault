import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { cashRegisterSessions } from "../../app/models/cash-register-sessions.js";
import { cashTransactions } from "../../app/models/cash-transactions.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { refunds } from "../../app/models/refunds.js";
import { saleItemBatches } from "../../app/models/sale-item-batches.js";
import { sales } from "../../app/models/sales.js";
import { salesReturnItems } from "../../app/models/sales-return-items.js";
import { salesReturns } from "../../app/models/sales-returns.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approveReturn,
  cancelReturn,
  createReturn,
  getReturn,
  getReturnableSale,
  listReturns,
  processReturn,
  rejectReturn,
  submitReturn,
} from "../../app/services/sales/returns.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeBranch,
  makeOpenSession,
  makeRegister,
  makeSale,
  makeWorld,
} from "../helpers/factories.js";

const NOW = new Date("2026-11-13T02:00:00Z");
const SOLD_AT = new Date("2026-11-12T01:00:00Z");

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

// One sale in MAIN: 10 tablets at 10.00 paid in cash (total 100.00), with the stock already taken
// off the shelf (99,990 of 100,000 left). A clerk drafts returns; the manager approves and
// processes, and has their own open register.
async function setup({ lineSpec = { quantity: "10", unitPrice: "10.00" }, ...overrides } = {}) {
  const onShelf = `${100000 - Number(lineSpec.quantity)}.000`;

  const world = await makeWorld();
  const clerk = await makeAuthUser({
    branchId: world.branch.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const manager = await makeAuthUser({
    branchId: world.branch.id,
    permissions: ROLE_PERMISSIONS.admin,
  });
  const north = await makeBranch({ code: "NORTH" });
  const stranger = await makeAuthUser({
    branchId: north.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const register = await makeRegister({ branchId: world.branch.id });
  const managerSession = await makeOpenSession({
    registerId: register.id,
    cashierId: manager.id,
    openedAt: SOLD_AT,
  });
  const sale = await makeSale({
    branchId: world.branch.id,
    cashierId: world.cashier.id,
    sessionId: world.session.id,
    transactionDate: SOLD_AT,
    lines: [
      {
        productId: world.product.id,
        productUnitId: world.unit.id,
        quantity: lineSpec.quantity,
        unitPrice: lineSpec.unitPrice,
        batches: [{ batchId: world.batch.id, quantity: lineSpec.quantity }],
      },
    ],
    payments: [{ method: "CASH", amount: "100.00" }],
    ...overrides,
  });

  await db
    .update(inventoryBatches)
    .set({ quantityAvailable: onShelf })
    .where(eq(inventoryBatches.id, world.batch.id));
  await db.update(inventories).set({ quantityOnHand: onShelf });

  const [piece] = await db.select().from(saleItemBatches);

  return { ...world, clerk, manager, stranger, managerSession, sale, piece };
}

const draft = (ctx, quantity, disposition = "RESTOCK", extra = {}) => {
  return createReturn(
    ctx.clerk,
    {
      saleId: ctx.sale.id,
      reason: "Wrong strength",
      lines: [{ saleItemBatchId: ctx.piece.id, quantity, disposition }],
      ...extra,
    },
    { now: NOW },
  );
};

// a processed return: submit, approve, process in cash
async function settle(ctx, quantity, disposition = "RESTOCK") {
  const { id } = await draft(ctx, quantity, disposition);

  await submitReturn(ctx.clerk, id, {}, { now: NOW });
  await approveReturn(ctx.manager, id, {}, { now: NOW });

  return await processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW });
}

const batchOf = async (ctx) => {
  const [row] = await db
    .select()
    .from(inventoryBatches)
    .where(eq(inventoryBatches.id, ctx.batch.id));

  return row;
};

const saleStatus = async (ctx) => {
  const [row] = await db.select().from(sales).where(eq(sales.id, ctx.sale.id));

  return row.status;
};

test.group("sales returns", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a draft snapshots the refund and does not touch stock or money", async ({ expect }) => {
    const ctx = await setup();
    const { id, returnNumber } = await draft(ctx, "4");
    const { salesReturn, lines } = await getReturn(ctx.clerk, id);

    expect(returnNumber).toMatch(/^RET-MAIN-20261113-0001$/);
    expect(salesReturn.status).toBe("DRAFT");
    expect(salesReturn.refundAmount).toBe("40.00");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      quantity: "4.000",
      refundAmount: "40.00",
      disposition: "RESTOCK",
    });
    expect((await batchOf(ctx)).quantityAvailable).toBe("99990.000");
    expect(await db.select().from(refunds)).toHaveLength(0);
  });

  test("a draft is refused for bad lines, other branches, old or unfinished sales", async ({
    expect,
  }) => {
    const ctx = await setup();
    const tooMuch = await failure(draft(ctx, "10.001"));
    const zero = await failure(draft(ctx, "0"));
    const noReason = await failure(draft(ctx, "1", "RESTOCK", { reason: "  " }));
    const badKind = await failure(draft(ctx, "1", "SELL_AGAIN"));
    const nobody = await failure(
      createReturn(ctx.stranger, { saleId: ctx.sale.id, reason: "x", lines: [] }, { now: NOW }),
    );
    const cashier = await makeAuthUser({
      branchId: ctx.branch.id,
      permissions: ["dashboard.view"],
    });
    const noRight = await failure(draft({ ...ctx, clerk: cashier }, "1"));

    expect(tooMuch.details[0].path).toBe("lines.0.quantity");
    expect(zero.details[0].path).toBe("lines.0.quantity");
    expect(noReason.details[0].path).toBe("reason");
    expect(badKind.details[0].path).toBe("lines.0.disposition");
    expect(nobody.status).toBe(404);
    expect(noRight.status).toBe(403);

    // 40 days later the sale is past the 30-day window
    const late = await failure(
      createReturn(
        ctx.clerk,
        {
          saleId: ctx.sale.id,
          reason: "Late",
          lines: [{ saleItemBatchId: ctx.piece.id, quantity: "1", disposition: "RESTOCK" }],
        },
        { now: new Date("2026-12-25T02:00:00Z") },
      ),
    );

    expect(late.status).toBe(409);
    expect(late.code).toBe("return_window");

    await db.update(sales).set({ status: "VOIDED" }).where(eq(sales.id, ctx.sale.id));

    expect((await failure(draft(ctx, "1"))).code).toBe("return_sale_state");
  });

  test("units already claimed by another return cannot be claimed again, until it is cancelled", async ({
    expect,
  }) => {
    const ctx = await setup();
    const first = await draft(ctx, "7");
    const over = await failure(draft(ctx, "4"));

    expect(over.details[0].message).toContain("3");
    expect((await draft(ctx, "3")).id).toBeDefined();

    await cancelReturn(ctx.clerk, first.id, { reason: "Customer changed mind" }, { now: NOW });

    expect((await draft(ctx, "7")).id).toBeDefined();
  });

  test("submit, a different person approves, processing restocks and refunds in cash", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "4");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });

    const self = await failure(approveReturn(ctx.clerk, id, {}, { now: NOW }));

    expect(self.status).toBe(403);

    const early = await failure(
      processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW }),
    );

    expect(early.status).toBe(409);

    await approveReturn(ctx.manager, id, {}, { now: NOW });

    const result = await processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW });
    const batch = await batchOf(ctx);
    const [stock] = await db.select().from(inventories);
    const [movement] = await db.select().from(inventoryMovements);
    const [refund] = await db.select().from(refunds);
    const [cash] = await db.select().from(cashTransactions);
    const [header] = await db.select().from(salesReturns);

    expect(result.status).toBe("PROCESSED");
    expect(batch.quantityAvailable).toBe("99994.000");
    expect(stock.quantityOnHand).toBe("99994.000");
    expect(movement).toMatchObject({
      movementType: "SALE_RETURN",
      referenceType: "sales_return",
      referenceId: id,
      quantityChange: "4.000",
      quantityBefore: "99990.000",
      quantityAfter: "99994.000",
    });
    expect(refund).toMatchObject({ paymentMethod: "CASH", amount: "40.00", status: "PROCESSED" });
    expect(cash).toMatchObject({
      transactionType: "CASH_REFUND",
      amount: "40.00",
      cashRegisterSessionId: ctx.managerSession.id,
      referenceId: id,
    });
    expect(header.approvedBy).toBe(ctx.manager.id);
    expect(await saleStatus(ctx)).toBe("PARTIALLY_REFUNDED");
  });

  test("returning the rest refunds exactly what is left and marks the sale refunded", async ({
    expect,
  }) => {
    const ctx = await setup();

    await settle(ctx, "3");
    await settle(ctx, "3");
    await settle(ctx, "4");

    const rows = await db.select().from(refunds);
    const total = rows.reduce((sum, row) => {
      return sum + Number(row.amount);
    }, 0);

    expect(rows).toHaveLength(3);
    expect(total).toBeCloseTo(100, 2);
    expect(await saleStatus(ctx)).toBe("REFUNDED");
    expect((await failure(draft(ctx, "1"))).code).toBe("return_sale_state");
  });

  test("rounded shares still add up to exactly the line total", async ({ expect }) => {
    // 100 tablets at 0.025 = 2.50; every third of it rounds
    const ctx = await setup({
      lineSpec: { quantity: "100", unitPrice: "0.0250" },
      payments: [{ method: "CASH", amount: "2.50" }],
    });

    await settle(ctx, "33");
    await settle(ctx, "33");
    await settle(ctx, "34");

    const amounts = (await db.select().from(refunds))
      .map((row) => {
        return row.amount;
      })
      .sort();

    expect(amounts).toEqual(["0.85", "0.83", "0.82"].sort());
    expect(await saleStatus(ctx)).toBe("REFUNDED");
  });

  test("a return that rounds to no money is refused at the draft", async ({ expect }) => {
    // 100 tablets at 0.025: a thousandth of a tablet is worth a fraction of a cent
    const ctx = await setup({
      lineSpec: { quantity: "100", unitPrice: "0.0250" },
      payments: [{ method: "CASH", amount: "2.50" }],
    });
    const error = await failure(draft(ctx, "0.001"));

    expect(error.details[0].path).toBe("lines.0.quantity");
    expect(error.details[0].message).toContain("too small");
  });

  test("a split-tender sale is refunded in parts, each within its method", async ({ expect }) => {
    const ctx = await setup({
      payments: [
        { method: "CASH", amount: "60.00" },
        { method: "GCASH", amount: "40.00", reference: "GC-1" },
      ],
    });
    const { id } = await draft(ctx, "10");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });
    await approveReturn(ctx.manager, id, {}, { now: NOW });

    const short = await failure(
      processReturn(
        ctx.manager,
        id,
        { refunds: [{ method: "CASH", amount: "60.00" }] },
        { now: NOW },
      ),
    );
    const over = await failure(
      processReturn(
        ctx.manager,
        id,
        {
          refunds: [
            { method: "CASH", amount: "50.00" },
            { method: "GCASH", amount: "50.00", referenceNumber: "R-1" },
          ],
        },
        { now: NOW },
      ),
    );

    expect(short.details[0].path).toBe("refunds");
    expect(over.details[0].path).toBe("refunds.1.amount");

    await processReturn(
      ctx.manager,
      id,
      {
        refunds: [
          { method: "CASH", amount: "60.00" },
          { method: "GCASH", amount: "40.00", referenceNumber: "R-1" },
        ],
      },
      { now: NOW },
    );

    const rows = await db.select().from(refunds);
    const [cash] = await db.select().from(cashTransactions);

    expect(
      rows
        .map((row) => {
          return `${row.paymentMethod}:${row.amount}`;
        })
        .sort(),
    ).toEqual(["CASH:60.00", "GCASH:40.00"]);
    expect(cash.amount).toBe("60.00");
    expect(await saleStatus(ctx)).toBe("REFUNDED");
  });

  test("a sale that stopped being returnable cannot be refunded", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "2");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });
    await approveReturn(ctx.manager, id, {}, { now: NOW });
    await db.update(sales).set({ status: "VOIDED" }).where(eq(sales.id, ctx.sale.id));

    const error = await failure(
      processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW }),
    );

    expect(error.code).toBe("return_sale_state");
    expect(await saleStatus(ctx)).toBe("VOIDED");
    expect(await db.select().from(refunds)).toHaveLength(0);
  });

  test("other dispositions record the units but leave the stock alone", async ({ expect }) => {
    const ctx = await setup();

    await settle(ctx, "2", "DAMAGED");
    await settle(ctx, "1", "QUARANTINE");
    await settle(ctx, "1", "DISPOSE");

    expect((await batchOf(ctx)).quantityAvailable).toBe("99990.000");
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);
    expect(await db.select().from(refunds)).toHaveLength(3);
    expect(
      (await db.select().from(salesReturnItems))
        .map((row) => {
          return row.disposition;
        })
        .sort(),
    ).toEqual(["DAMAGED", "DISPOSE", "QUARANTINE"]);
  });

  test("a restock into a batch that cannot take it is refused at the draft and at processing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "2");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });
    await approveReturn(ctx.manager, id, {}, { now: NOW });
    await db
      .update(inventoryBatches)
      .set({ status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.batch.id));

    const blocked = await failure(
      processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW }),
    );
    const refused = await failure(draft(ctx, "1"));

    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("return_restock");
    expect(refused.details[0].path).toBe("lines.0.disposition");
    expect(await db.select().from(refunds)).toHaveLength(0);
    expect((await draft(ctx, "1", "DISPOSE")).id).toBeDefined();
  });

  test("the refund must go back the way the money came, with what it needs", async ({ expect }) => {
    const ctx = await setup({
      payments: [
        { method: "CASH", amount: "60.00" },
        { method: "GCASH", amount: "40.00", reference: "GC-1" },
      ],
    });
    const { id } = await draft(ctx, "10");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });
    await approveReturn(ctx.manager, id, {}, { now: NOW });

    const noMethod = await failure(processReturn(ctx.manager, id, {}, { now: NOW }));
    const unused = await failure(
      processReturn(ctx.manager, id, { refundMethod: "CARD", referenceNumber: "X" }, { now: NOW }),
    );
    const noReference = await failure(
      processReturn(ctx.manager, id, { refundMethod: "GCASH" }, { now: NOW }),
    );
    const tooBig = await failure(
      processReturn(
        ctx.manager,
        id,
        { refundMethod: "GCASH", referenceNumber: "R-1" },
        { now: NOW },
      ),
    );

    expect(noMethod.details[0].path).toBe("refundMethod");
    expect(unused.details[0].path).toBe("refundMethod");
    expect(noReference.details[0].path).toBe("referenceNumber");
    expect(tooBig.details[0].path).toBe("refundMethod");
    expect(tooBig.details[0].message).toContain("40.00");
    expect(await db.select().from(refunds)).toHaveLength(0);
  });

  test("cash needs the processor's own open register", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "1");

    await submitReturn(ctx.clerk, id, {}, { now: NOW });
    await approveReturn(ctx.manager, id, {}, { now: NOW });
    await db
      .update(cashRegisterSessions)
      .set({ status: "CLOSED" })
      .where(eq(cashRegisterSessions.id, ctx.managerSession.id));

    const closed = await failure(
      processReturn(ctx.manager, id, { refundMethod: "CASH" }, { now: NOW }),
    );

    expect(closed.status).toBe(409);
    expect(closed.code).toBe("register_closed");
    expect(await db.select().from(cashTransactions)).toHaveLength(0);
    expect((await getReturn(ctx.manager, id)).salesReturn.status).toBe("APPROVED");
  });

  test("reject and cancel need a reason; the list and detail stay in the branch", async ({
    expect,
  }) => {
    const ctx = await setup();
    const one = await draft(ctx, "1");
    const two = await draft(ctx, "1");

    await submitReturn(ctx.clerk, two.id, {}, { now: NOW });

    expect(
      (await failure(rejectReturn(ctx.manager, two.id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");
    expect((await failure(cancelReturn(ctx.clerk, one.id, {}, { now: NOW }))).details[0].path).toBe(
      "reason",
    );

    await rejectReturn(ctx.manager, two.id, { reason: "Not ours" }, { now: NOW });
    await cancelReturn(ctx.clerk, one.id, { reason: "Changed mind" }, { now: NOW });

    const everything = await listReturns(ctx.clerk, {});
    const rejected = await listReturns(ctx.clerk, { status: "REJECTED" });
    const elsewhere = await listReturns(ctx.stranger, {});

    expect(everything.total).toBe(2);
    expect(
      rejected.rows.map((row) => {
        return row.id;
      }),
    ).toEqual([two.id]);
    expect(elsewhere.total).toBe(0);
    expect((await failure(getReturn(ctx.stranger, one.id))).status).toBe(404);
    expect((await failure(getReturn(ctx.clerk, "not-an-id"))).status).toBe(404);
  });

  test("the return form lists what is still returnable", async ({ expect }) => {
    const ctx = await setup();

    await settle(ctx, "6");

    const { sale, pieces } = await getReturnableSale(ctx.clerk, ctx.sale.id);

    expect(sale.id).toBe(ctx.sale.id);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({
      id: ctx.piece.id,
      sold: "10.000",
      returned: "6.000",
      remaining: "4.000",
    });
    expect((await failure(getReturnableSale(ctx.stranger, ctx.sale.id))).status).toBe(404);
  });
});
