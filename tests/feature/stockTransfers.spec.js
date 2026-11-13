import { test } from "@japa/runner";
import { and, eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { stockTransferItems } from "../../app/models/stock-transfer-items.js";
import { stockTransfers } from "../../app/models/stock-transfers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approveTransfer,
  cancelTransfer,
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransferableBatches,
  listTransferSources,
  listTransfers,
  receiveTransfer,
  rejectTransfer,
  submitTransfer,
} from "../../app/services/inventory/transfers.js";
import { resetDatabase } from "../helpers/db.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { makeAuthUser, makeBranch, makeProduct, makeStock } from "../helpers/factories.js";

const won = (runs) => {
  return runs.filter((run) => {
    return run.status === "fulfilled";
  }).length;
};

const NOW = new Date("2026-11-13T02:00:00Z");

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

// MAIN ships to NORTH. MAIN holds LOT-A (500) and LOT-B (40) of one product; NORTH holds nothing of it.
async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const east = await makeBranch({ code: "EAST" });
  const person = (branch, permissions) => {
    return makeAuthUser({ branchId: branch.id, permissions });
  };
  const stock = await makeProduct({
    branchId: main.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [
      { quantity: "500", batchNumber: "LOT-A", unitCost: "2.0000", expirationDate: "2029-06-30" },
      { quantity: "40", batchNumber: "LOT-B", unitCost: "3.0000" },
    ],
  });
  const own = await makeProduct({
    branchId: north.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "10", batchNumber: "LOT-N" }],
  });

  return {
    main,
    north,
    stock,
    own,
    a: stock.batches[0],
    b: stock.batches[1],
    requester: await person(north, ROLE_PERMISSIONS.pharmacist),
    northAdmin: await person(north, ROLE_PERMISSIONS.admin),
    shipper: await person(main, ROLE_PERMISSIONS.pharmacist),
    approver: await person(main, ROLE_PERMISSIONS.admin),
    outsider: await person(east, ROLE_PERMISSIONS.admin),
    eastClerk: await person(east, ROLE_PERMISSIONS.pharmacist),
    accountant: await person(north, ROLE_PERMISSIONS.accountant),
    cashier: await person(north, ROLE_PERMISSIONS.cashier),
  };
}

const request = (ctx, quantity = "100", extra = {}) => {
  return createTransfer(
    ctx.requester,
    {
      sourceBranchId: ctx.main.id,
      lines: [{ sourceBatchId: ctx.a.id, quantity }],
      ...extra,
    },
    { now: NOW },
  );
};

const itemsOf = async (id) => {
  return await db
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.stockTransferId, id));
};

// a transfer that is approved and ready to ship
async function approved(ctx, quantity = "100") {
  const { id } = await request(ctx, quantity);

  await submitTransfer(ctx.requester, id, {}, { now: NOW });
  await approveTransfer(ctx.approver, id, {}, { now: NOW });

  return id;
}

const shipAll = async (ctx, id, quantity) => {
  const [item] = await itemsOf(id);

  return await dispatchTransfer(
    ctx.shipper,
    id,
    { lines: [{ itemId: item.id, quantity }] },
    { now: NOW },
  );
};

const batchOf = async (batch) => {
  const [row] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, batch.id));

  return row;
};

const statusOf = async (id) => {
  const [row] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id));

  return row.status;
};

test.group("stock transfers", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a draft is numbered by the destination and moves no stock", async ({ expect }) => {
    const ctx = await setup();
    const { id, transferNumber } = await request(ctx, "100");
    const { transfer, lines } = await getTransfer(ctx.requester, id);

    expect(transferNumber).toBe("TRF-NORTH-20261113-0001");
    expect(transfer).toMatchObject({ status: "DRAFT", sourceBranchName: ctx.main.name });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ batchNumber: "LOT-A", quantityRequested: "100.000" });
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("500.000");
  });

  test("a draft is refused for bad sources, batches and quantities", async ({ expect }) => {
    const ctx = await setup();
    const draftWith = (lines, sourceBranchId = ctx.main.id, user = ctx.requester) => {
      return createTransfer(user, { sourceBranchId, lines }, { now: NOW });
    };
    const same = await failure(draftWith([], ctx.north.id));
    const unknown = await failure(draftWith([], "nope"));
    const empty = await failure(draftWith([]));
    const zero = await failure(draftWith([{ sourceBatchId: ctx.a.id, quantity: "0" }]));
    const tooMuch = await failure(draftWith([{ sourceBatchId: ctx.b.id, quantity: "41" }]));
    const elsewhere = await failure(
      draftWith([{ sourceBatchId: ctx.own.batches[0].id, quantity: "1" }]),
    );
    const twice = await failure(
      draftWith([
        { sourceBatchId: ctx.a.id, quantity: "1" },
        { sourceBatchId: ctx.a.id, quantity: "2" },
      ]),
    );

    await db
      .update(inventoryBatches)
      .set({ status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.b.id));

    const recalled = await failure(draftWith([{ sourceBatchId: ctx.b.id, quantity: "1" }]));

    expect(same.details[0].path).toBe("sourceBranchId");
    expect(unknown.details[0].path).toBe("sourceBranchId");
    expect(empty.details[0].path).toBe("lines");
    expect(zero.details[0].path).toBe("lines.0.quantity");
    expect(tooMuch.details[0].path).toBe("lines.0.quantity");
    expect(tooMuch.details[0].message).toContain("40");
    expect(elsewhere.details[0].path).toBe("lines.0.sourceBatchId");
    expect(twice.details[0].path).toBe("lines.1.sourceBatchId");
    expect(recalled.details[0].path).toBe("lines.0.sourceBatchId");
    expect((await failure(draftWith([], ctx.main.id, ctx.cashier))).status).toBe(403);
    expect((await failure(draftWith([], ctx.main.id, ctx.accountant))).status).toBe(403);
  });

  test("the destination submits, only the source's approver approves", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await request(ctx);

    expect((await failure(submitTransfer(ctx.shipper, id, {}, { now: NOW }))).status).toBe(403);
    await submitTransfer(ctx.requester, id, {}, { now: NOW });

    expect((await failure(approveTransfer(ctx.shipper, id, {}, { now: NOW }))).status).toBe(403);
    // an admin of the destination is the wrong side
    expect((await failure(approveTransfer(ctx.northAdmin, id, {}, { now: NOW }))).status).toBe(403);
    expect((await failure(approveTransfer(ctx.outsider, id, {}, { now: NOW }))).status).toBe(404);
    expect(
      (await failure(dispatchTransfer(ctx.shipper, id, { lines: [] }, { now: NOW }))).status,
    ).toBe(409);

    await approveTransfer(ctx.approver, id, {}, { now: NOW });

    expect(await statusOf(id)).toBe("APPROVED");
  });

  test("dispatch takes stock off the source and parks it in transit", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");
    const noRight = await failure(dispatchTransfer(ctx.requester, id, { lines: [] }, { now: NOW }));
    const none = await failure(shipAll(ctx, id, "0"));
    const more = await failure(shipAll(ctx, id, "101"));

    expect(noRight.status).toBe(403);
    expect(none.details[0].path).toBe("lines");
    expect(more.details[0].path).toBe("lines.0.quantity");

    const result = await shipAll(ctx, id, "90");
    const [stock] = await db
      .select()
      .from(inventories)
      .where(eq(inventories.id, ctx.a.inventoryId));
    const [movement] = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.movementType, "STOCK_TRANSFER_OUT"));
    const [item] = await itemsOf(id);

    expect(result.status).toBe("IN_TRANSIT");
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("410.000");
    expect(stock.quantityOnHand).toBe("450.000");
    expect(movement).toMatchObject({
      branchId: ctx.main.id,
      referenceType: "stock_transfer",
      referenceId: id,
      quantityChange: "-90.000",
      quantityBefore: "500.000",
      quantityAfter: "410.000",
    });
    expect(item.quantityShipped).toBe("90.000");
    // nothing is on the destination's books yet
    expect(
      await db.select().from(inventoryBatches).where(eq(inventoryBatches.branchId, ctx.north.id)),
    ).toHaveLength(1);
  });

  test("dispatch is refused when the batch moved or was recalled", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "60.000" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    const short = await failure(shipAll(ctx, id, "100"));

    expect(short.status).toBe(409);
    expect(short.code).toBe("transfer_stock");

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "500.000", status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    expect((await failure(shipAll(ctx, id, "100"))).code).toBe("transfer_stock");
    expect(await statusOf(id)).toBe("APPROVED");
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("500.000");
  });

  test("receiving creates the destination batch with the same lot, then adds to it", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await shipAll(ctx, id, "90");

    const [item] = await itemsOf(id);
    const receive = (quantity, user = ctx.requester) => {
      return receiveTransfer(user, id, { lines: [{ itemId: item.id, quantity }] }, { now: NOW });
    };

    expect((await failure(receive("10", ctx.shipper))).status).toBe(403);
    expect((await failure(receive("91"))).details[0].path).toBe("lines.0.quantity");
    expect((await failure(receive("0"))).details[0].path).toBe("lines");
    expect((await receive("30")).status).toBe("PARTIALLY_RECEIVED");

    const [mid] = await itemsOf(id);
    const [copy] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, mid.destinationInventoryBatchId));
    const [stock] = await db
      .select()
      .from(inventories)
      .where(
        and(
          eq(inventories.branchId, ctx.north.id),
          eq(inventories.productId, ctx.stock.product.id),
        ),
      );

    expect(copy).toMatchObject({
      branchId: ctx.north.id,
      batchNumber: "LOT-A",
      quantityReceived: "30.000",
      quantityAvailable: "30.000",
      unitCost: "2.0000",
      status: "ACTIVE",
    });
    expect(String(copy.expirationDate)).toContain("2029");
    expect(stock.quantityOnHand).toBe("30.000");
    expect((await failure(receive("61"))).details[0].path).toBe("lines.0.quantity");

    expect((await receive("60")).status).toBe("RECEIVED");

    const done = await batchOf({ id: mid.destinationInventoryBatchId });
    const movements = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.movementType, "STOCK_TRANSFER_IN"));

    expect(done.quantityAvailable).toBe("90.000");
    expect(done.quantityReceived).toBe("90.000");
    expect(movements).toHaveLength(2);
    expect((await failure(receive("1"))).status).toBe(409);
    expect((await batchOf({ id: mid.destinationInventoryBatchId })).quantityAvailable).toBe(
      "90.000",
    );
  });

  test("a shortage can be closed with a reason", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await shipAll(ctx, id, "100");

    const [item] = await itemsOf(id);

    await receiveTransfer(
      ctx.requester,
      id,
      { lines: [{ itemId: item.id, quantity: "70" }] },
      { now: NOW },
    );

    expect(
      (await failure(closeTransfer(ctx.requester, id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");
    expect(
      (await failure(closeTransfer(ctx.shipper, id, { reason: "Lost" }, { now: NOW }))).status,
    ).toBe(403);

    await closeTransfer(ctx.requester, id, { reason: "30 tablets lost in transit" }, { now: NOW });

    expect(await statusOf(id)).toBe("RECEIVED");
    expect(
      (await batchOf({ id: (await itemsOf(id))[0].destinationInventoryBatchId })).quantityAvailable,
    ).toBe("70.000");
  });

  test("reject and cancel need a reason and cancel stops at dispatch", async ({ expect }) => {
    const ctx = await setup();
    const one = await request(ctx);
    const two = await request(ctx);
    const three = await approved(ctx);

    await submitTransfer(ctx.requester, two.id, {}, { now: NOW });

    expect(
      (await failure(rejectTransfer(ctx.approver, two.id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");
    expect(
      (await failure(cancelTransfer(ctx.requester, one.id, {}, { now: NOW }))).details[0].path,
    ).toBe("reason");

    await rejectTransfer(ctx.approver, two.id, { reason: "Not enough to spare" }, { now: NOW });
    await cancelTransfer(ctx.requester, one.id, { reason: "No longer needed" }, { now: NOW });
    // the source's approver may call off an approved transfer, a source clerk may not
    expect(
      (await failure(cancelTransfer(ctx.shipper, three, { reason: "x" }, { now: NOW }))).status,
    ).toBe(403);
    await cancelTransfer(ctx.approver, three, { reason: "Stock needed here" }, { now: NOW });

    expect(await statusOf(one.id)).toBe("CANCELLED");
    expect(await statusOf(two.id)).toBe("REJECTED");
    expect(await statusOf(three)).toBe("CANCELLED");

    const four = await approved(ctx);

    await shipAll(ctx, four, "100");

    expect(
      (await failure(cancelTransfer(ctx.requester, four, { reason: "Too late" }, { now: NOW })))
        .status,
    ).toBe(409);
  });

  test("only the two branches see a transfer; the pickers list what can be requested", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await request(ctx);

    expect((await getTransfer(ctx.shipper, id)).transfer.id).toBe(id);
    expect((await failure(getTransfer(ctx.eastClerk, id))).status).toBe(404);
    expect((await listTransfers(ctx.eastClerk, {})).total).toBe(0);
    expect((await failure(getTransfer(ctx.requester, "not-an-id"))).status).toBe(404);
    expect((await listTransfers(ctx.requester, {})).total).toBe(1);
    expect((await listTransfers(ctx.shipper, { status: "DRAFT" })).total).toBe(1);
    expect((await listTransfers(ctx.shipper, { status: "APPROVED" })).total).toBe(0);
    expect((await listTransfers(ctx.outsider, {})).total).toBe(1); // admin: all-branch scope

    const sources = await listTransferSources(ctx.requester);
    const batches = await listTransferableBatches(ctx.requester, ctx.main.id);

    expect(
      sources.map((branch) => {
        return branch.code;
      }),
    ).toEqual(["EAST", "MAIN"]);
    expect(
      batches.map((batch) => {
        return batch.batchNumber;
      }),
    ).toEqual(["LOT-A", "LOT-B"]);
    expect(await listTransferableBatches(ctx.requester, ctx.north.id)).toEqual([]);
  });
  test("lines of several products ship and arrive together, into stock the destination already holds", async ({
    expect,
  }) => {
    const ctx = await setup();
    const other = await makeProduct({
      branchId: ctx.main.id,
      units: [{ name: "Tablet", factor: "1", base: true }],
      batches: [{ quantity: "70", batchNumber: "LOT-P2" }],
    });

    await makeStock({
      productId: ctx.stock.product.id,
      branchId: ctx.north.id,
      batches: [{ quantity: "10", batchNumber: "LOT-N" }],
    });

    const { id } = await createTransfer(
      ctx.requester,
      {
        sourceBranchId: ctx.main.id,
        lines: [
          { sourceBatchId: ctx.a.id, quantity: "100" },
          { sourceBatchId: ctx.b.id, quantity: "20" },
          { sourceBatchId: other.batches[0].id, quantity: "50" },
        ],
      },
      { now: NOW },
    );

    await submitTransfer(ctx.requester, id, {}, { now: NOW });
    await approveTransfer(ctx.approver, id, {}, { now: NOW });

    const items = await itemsOf(id);
    const byBatch = (batch) => {
      return items.find((item) => {
        return item.sourceInventoryBatchId === batch.id;
      });
    };
    const ship = { [ctx.a.id]: "100", [ctx.b.id]: "0", [other.batches[0].id]: "50" };

    await dispatchTransfer(
      ctx.shipper,
      id,
      {
        lines: [
          ...[ctx.a, ctx.b, other.batches[0]].map((batch) => {
            return { itemId: byBatch(batch).id, quantity: ship[batch.id] };
          }),
          { itemId: "00000000-0000-4000-8000-000000000000", quantity: "5" },
        ],
      },
      { now: NOW },
    );

    const [mainOne] = await db
      .select()
      .from(inventories)
      .where(eq(inventories.id, ctx.a.inventoryId));
    const [mainTwo] = await db
      .select()
      .from(inventories)
      .where(eq(inventories.id, other.inventoryId));

    expect(mainOne.quantityOnHand).toBe("440.000");
    expect(mainTwo.quantityOnHand).toBe("20.000");
    expect((await batchOf(ctx.b)).quantityAvailable).toBe("40.000");

    const fresh = await itemsOf(id);
    const arrive = fresh.map((item) => {
      return { itemId: item.id, quantity: item.quantityShipped };
    });
    const result = await receiveTransfer(ctx.requester, id, { lines: arrive }, { now: NOW });
    const north = await db.select().from(inventories).where(eq(inventories.branchId, ctx.north.id));
    const onHand = Object.fromEntries(
      north.map((row) => {
        return [row.productId, row.quantityOnHand];
      }),
    );

    // the shipped-as-zero line needs nothing more to be complete
    expect(result.status).toBe("RECEIVED");
    expect(onHand[ctx.stock.product.id]).toBe("110.000");
    expect(onHand[other.product.id]).toBe("50.000");
    expect(
      (await itemsOf(id)).filter((item) => {
        return item.destinationInventoryBatchId !== null;
      }),
    ).toHaveLength(2);
  });

  test("lots recalled or expired in transit arrive as such, not as sellable stock", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await shipAll(ctx, id, "100");
    await db
      .update(inventoryBatches)
      .set({ status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    const [item] = await itemsOf(id);

    await receiveTransfer(
      ctx.requester,
      id,
      { lines: [{ itemId: item.id, quantity: "100" }] },
      { now: NOW },
    );

    const [copy] = await db
      .select()
      .from(inventoryBatches)
      .where(
        and(eq(inventoryBatches.branchId, ctx.north.id), eq(inventoryBatches.batchNumber, "LOT-A")),
      );

    expect(copy.batchNumber).toBe("LOT-A");
    expect(copy.status).toBe("RECALLED");
  });

  test("closing a shortage records what was short", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");

    await shipAll(ctx, id, "100");

    const [item] = await itemsOf(id);

    await receiveTransfer(
      ctx.requester,
      id,
      { lines: [{ itemId: item.id, quantity: "70" }] },
      { now: NOW },
    );
    await closeTransfer(ctx.requester, id, { reason: "Box crushed" }, { now: NOW });

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "TRANSFER_CLOSED_SHORT"));
    const text = JSON.stringify(row);

    expect(text).toContain("Box crushed");
    expect(text).toContain("30.000");
    expect(text).toContain("LOT-A");
  });

  test("two people acting at once: one dispatch and one receipt win, stock is conserved", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await approved(ctx, "100");
    const [item] = await itemsOf(id);
    const send = () => {
      return dispatchTransfer(
        ctx.shipper,
        id,
        { lines: [{ itemId: item.id, quantity: "100" }] },
        { now: NOW },
      );
    };
    const dispatches = await Promise.allSettled([send(), send()]);

    expect(won(dispatches)).toBe(1);
    expect((await batchOf(ctx.a)).quantityAvailable).toBe("400.000");

    const take = () => {
      return receiveTransfer(
        ctx.requester,
        id,
        { lines: [{ itemId: item.id, quantity: "100" }] },
        { now: NOW },
      );
    };
    const receipts = await Promise.allSettled([take(), take()]);
    const [copy] = await db
      .select()
      .from(inventoryBatches)
      .where(
        and(eq(inventoryBatches.branchId, ctx.north.id), eq(inventoryBatches.batchNumber, "LOT-A")),
      );

    expect(won(receipts)).toBe(1);
    expect(copy.quantityAvailable).toBe("100.000");
  });
});
