import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { purchaseReturns } from "../../app/models/purchase-returns.js";
import { suppliers } from "../../app/models/suppliers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approvePurchaseReturn,
  cancelPurchaseReturn,
  createPurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
  listReturnableBatches,
  postPurchaseReturn,
  rejectPurchaseReturn,
  submitPurchaseReturn,
} from "../../app/services/purchasing/purchaseReturns.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct } from "../helpers/factories.js";

const NOW = new Date("2026-11-13T02:00:00Z");

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

// MAIN holds LOT-A (500, cost 2.00) and LOT-B (40, cost 3.00); NORTH has its own stock and staff.
async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const person = (branch, permissions) => {
    return makeAuthUser({ branchId: branch.id, permissions });
  };
  const supplier = { id: randomUUID(), code: "SUP-1", name: "Acme Pharma Supply" };

  await db.insert(suppliers).values(supplier);

  const stock = await makeProduct({
    branchId: main.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [
      { quantity: "500", batchNumber: "LOT-A", unitCost: "2.0000" },
      { quantity: "40", batchNumber: "LOT-B", unitCost: "3.0000" },
    ],
  });
  const other = await makeProduct({
    branchId: north.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "10", batchNumber: "LOT-N" }],
  });

  return {
    main,
    north,
    supplier,
    a: stock.batches[0],
    b: stock.batches[1],
    northBatch: other.batches[0],
    clerk: await person(main, ROLE_PERMISSIONS.pharmacist),
    manager: await person(main, ROLE_PERMISSIONS.admin),
    stranger: await person(north, ROLE_PERMISSIONS.pharmacist),
    accountant: await person(main, ROLE_PERMISSIONS.accountant),
    cashier: await person(main, ROLE_PERMISSIONS.cashier),
  };
}

const draft = (ctx, quantity = "50", extra = {}) => {
  return createPurchaseReturn(
    ctx.clerk,
    {
      supplierId: ctx.supplier.id,
      reason: "Damaged in transit",
      lines: [{ inventoryBatchId: ctx.a.id, quantity }],
      ...extra,
    },
    { now: NOW },
  );
};

const batchOf = async (batch) => {
  const [row] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, batch.id));

  return row;
};

const statusOf = async (id) => {
  const [row] = await db.select().from(purchaseReturns).where(eq(purchaseReturns.id, id));

  return row.status;
};

async function approved(ctx, quantity = "50") {
  const { id } = await draft(ctx, quantity);

  await submitPurchaseReturn(ctx.clerk, id, {}, { now: NOW });
  await approvePurchaseReturn(ctx.manager, id, {}, { now: NOW });

  return id;
}

test.group("supplier purchase returns", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a draft is numbered, values the stock at its cost and moves nothing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id, returnNumber } = await draft(ctx, "50");
    const { purchaseReturn, lines } = await getPurchaseReturn(ctx.clerk, id);

    expect(returnNumber).toBe("PRT-MAIN-20261113-0001");
    expect(purchaseReturn).toMatchObject({
      status: "DRAFT",
      supplierName: "Acme Pharma Supply",
      totalValue: "100.00",
    });
    expect(lines[0]).toMatchObject({
      batchNumber: "LOT-A",
      quantity: "50.000",
      unitCost: "2.0000",
      value: "100.00",
    });
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("500.000");
  });

  test("a draft is refused for bad suppliers, batches, quantities and people", async ({
    expect,
  }) => {
    const ctx = await setup();
    const make = (input, user = ctx.clerk) => {
      return createPurchaseReturn(
        user,
        { supplierId: ctx.supplier.id, reason: "Wrong item", ...input },
        { now: NOW },
      );
    };
    const paths = async (input) => {
      return (await failure(make(input))).details.map((detail) => {
        return detail.path;
      });
    };

    expect(
      await paths({ supplierId: "nope", lines: [{ inventoryBatchId: ctx.a.id, quantity: "1" }] }),
    ).toContain("supplierId");
    expect(
      await paths({ reason: " ", lines: [{ inventoryBatchId: ctx.a.id, quantity: "1" }] }),
    ).toContain("reason");
    expect(await paths({ lines: [] })).toContain("lines");
    expect(await paths({ lines: [{ inventoryBatchId: ctx.a.id, quantity: "0" }] })).toContain(
      "lines.0.quantity",
    );
    expect(await paths({ lines: [{ inventoryBatchId: ctx.b.id, quantity: "41" }] })).toContain(
      "lines.0.quantity",
    );
    expect(
      await paths({ lines: [{ inventoryBatchId: ctx.northBatch.id, quantity: "1" }] }),
    ).toContain("lines.0.inventoryBatchId");
    expect(
      await paths({
        lines: [
          { inventoryBatchId: ctx.a.id, quantity: "1" },
          { inventoryBatchId: ctx.a.id, quantity: "1" },
        ],
      }),
    ).toContain("lines.1.inventoryBatchId");

    await db
      .update(inventoryBatches)
      .set({ status: "DEPLETED" })
      .where(eq(inventoryBatches.id, ctx.b.id));

    expect(await paths({ lines: [{ inventoryBatchId: ctx.b.id, quantity: "1" }] })).toContain(
      "lines.0.inventoryBatchId",
    );
    expect((await failure(make({ lines: [] }, ctx.cashier))).status).toBe(403);
    expect((await failure(make({ lines: [] }, ctx.accountant))).status).toBe(403);
  });

  test("returned stock may be recalled or expired; the picker lists what can go back", async ({
    expect,
  }) => {
    const ctx = await setup();

    await db
      .update(inventoryBatches)
      .set({ status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.b.id));

    expect(
      (await draft(ctx, "5", { lines: [{ inventoryBatchId: ctx.b.id, quantity: "5" }] })).id,
    ).toBeDefined();
    expect(
      (await listReturnableBatches(ctx.clerk)).map((batch) => {
        return batch.batchNumber;
      }),
    ).toEqual(["LOT-A", "LOT-B"]);
  });

  test("submit, a different person approves, posting takes the stock off", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "50");

    await submitPurchaseReturn(ctx.clerk, id, {}, { now: NOW });

    expect((await failure(approvePurchaseReturn(ctx.clerk, id, {}, { now: NOW }))).status).toBe(
      403,
    );
    expect((await failure(postPurchaseReturn(ctx.manager, id, {}, { now: NOW }))).status).toBe(409);

    await approvePurchaseReturn(ctx.manager, id, {}, { now: NOW });

    expect((await failure(postPurchaseReturn(ctx.clerk, id, {}, { now: NOW }))).status).toBe(403);
    expect((await failure(postPurchaseReturn(ctx.stranger, id, {}, { now: NOW }))).status).toBe(
      403,
    );

    await postPurchaseReturn(ctx.manager, id, {}, { now: NOW });

    const [stock] = await db
      .select()
      .from(inventories)
      .where(eq(inventories.id, ctx.a.inventoryId));
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.movementType, "PURCHASE_RETURN"));

    expect(await statusOf(id)).toBe("POSTED");
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("450.000");
    expect(stock.quantityOnHand).toBe("490.000");
    expect(movement).toMatchObject({
      branchId: ctx.main.id,
      referenceType: "purchase_return",
      referenceId: id,
      quantityChange: "-50.000",
      quantityBefore: "500.000",
      quantityAfter: "450.000",
      unitCost: "2.0000",
    });
    expect((await failure(postPurchaseReturn(ctx.manager, id, {}, { now: NOW }))).status).toBe(409);
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("450.000");
  });

  test("returning a whole batch depletes it", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await draft(ctx, "500");

    await submitPurchaseReturn(ctx.clerk, id, {}, { now: NOW });
    await approvePurchaseReturn(ctx.manager, id, {}, { now: NOW });
    await postPurchaseReturn(ctx.manager, id, {}, { now: NOW });

    expect(await batchOf(ctx.a)).toMatchObject({ quantityAvailable: "0.000", status: "DEPLETED" });
  });

  test("posting is refused when the stock moved since, and nothing changes", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "60.000" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    const short = await failure(postPurchaseReturn(ctx.manager, id, {}, { now: NOW }));

    expect(short.status).toBe(409);
    expect(short.code).toBe("return_stock");

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "500.000", status: "DEPLETED" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    expect((await failure(postPurchaseReturn(ctx.manager, id, {}, { now: NOW }))).code).toBe(
      "return_stock",
    );
    expect(await statusOf(id)).toBe("APPROVED");
    expect(
      await db
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.movementType, "PURCHASE_RETURN")),
    ).toHaveLength(0);
  });

  test("two people posting at once: exactly one wins", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");
    const runs = await Promise.allSettled([
      postPurchaseReturn(ctx.manager, id, {}, { now: NOW }),
      postPurchaseReturn(ctx.manager, id, {}, { now: NOW }),
    ]);

    expect(
      runs.filter((run) => {
        return run.status === "fulfilled";
      }),
    ).toHaveLength(1);
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("400.000");
  });

  test("reject and cancel need a reason; the list and detail stay in the branch", async ({
    expect,
  }) => {
    const ctx = await setup();
    const one = await draft(ctx);
    const two = await draft(ctx);
    const three = await approved(ctx);

    await submitPurchaseReturn(ctx.clerk, two.id, {}, { now: NOW });

    expect(
      (await failure(rejectPurchaseReturn(ctx.manager, two.id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");
    expect(
      (await failure(cancelPurchaseReturn(ctx.clerk, one.id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");

    await rejectPurchaseReturn(ctx.manager, two.id, { reason: "Keep it" }, { now: NOW });
    await cancelPurchaseReturn(ctx.clerk, one.id, { reason: "Not needed" }, { now: NOW });
    await cancelPurchaseReturn(ctx.manager, three, { reason: "Supplier refused" }, { now: NOW });

    expect(await statusOf(one.id)).toBe("CANCELLED");
    expect(await statusOf(two.id)).toBe("REJECTED");
    expect(await statusOf(three)).toBe("CANCELLED");
    expect((await listPurchaseReturns(ctx.clerk, {})).total).toBe(3);
    expect((await listPurchaseReturns(ctx.clerk, { status: "REJECTED" })).total).toBe(1);
    expect((await listPurchaseReturns(ctx.stranger, {})).total).toBe(0);
    expect((await failure(getPurchaseReturn(ctx.stranger, one.id))).status).toBe(404);
    expect((await failure(getPurchaseReturn(ctx.clerk, "not-an-id"))).status).toBe(404);
  });
});
