import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approveAdjustment,
  cancelAdjustment,
  createAdjustment,
  getAdjustment,
  listAdjustments,
  listCountableBatches,
  postAdjustment,
  rejectAdjustment,
  submitAdjustment,
} from "../../app/services/inventory/adjustments.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct } from "../helpers/factories.js";

const NOW = new Date("2026-11-12T02:00:00Z");

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

const paths = (error) => {
  return error.details.map((detail) => {
    return detail.path;
  });
};

// MAIN holds one product with a 500-tablet batch; NORTH has its own stock.
async function setup() {
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
  const accountant = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.accountant,
  });
  const stock = await makeProduct({
    branchId: branch.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [
      { quantity: "500", batchNumber: "LOT-A" },
      { quantity: "40", batchNumber: "LOT-B" },
    ],
  });
  const north = await makeProduct({
    branchId: other.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "10", batchNumber: "LOT-N" }],
  });

  return {
    branch,
    clerk,
    manager,
    stranger,
    accountant,
    stock,
    north,
    a: stock.batches[0],
    b: stock.batches[1],
  };
}

const draft = (ctx, lines, extra) => {
  return {
    reason: "Quarterly count",
    lines: lines ?? [{ inventoryBatchId: ctx.a.id, countedQuantity: "485" }],
    ...extra,
  };
};

async function approved(ctx, lines) {
  const { id } = await createAdjustment(ctx.clerk, draft(ctx, lines), { now: NOW });

  await submitAdjustment(ctx.clerk, id);
  await approveAdjustment(ctx.manager, id, {}, { now: NOW });

  return id;
}

const batchRow = async (id) => {
  const [row] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, id));

  return row;
};

const onHand = async (ctx) => {
  const [row] = await db
    .select()
    .from(inventories)
    .where(eq(inventories.id, ctx.stock.inventoryId));

  return row.quantityOnHand;
};

test.group("stock adjustments", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a draft snapshots the recorded quantity and numbers the document", async ({ expect }) => {
    const ctx = await setup();
    const { id, adjustmentNumber } = await createAdjustment(
      ctx.clerk,
      draft(ctx, [
        { inventoryBatchId: ctx.a.id, countedQuantity: "485" },
        { inventoryBatchId: ctx.b.id, countedQuantity: "40" },
        { inventoryBatchId: "", countedQuantity: "" },
      ]),
      { now: NOW },
    );
    const { adjustment, lines } = await getAdjustment(ctx.clerk, id);
    const first = lines.find((line) => {
      return line.batchNumber === "LOT-A";
    });
    const second = lines.find((line) => {
      return line.batchNumber === "LOT-B";
    });

    expect(adjustmentNumber).toBe("ADJ-MAIN-20261112-0001");
    expect(adjustment.status).toBe("DRAFT");
    expect(lines).toHaveLength(2);
    expect([first.quantityBefore, first.countedQuantity, first.quantityChange]).toEqual([
      "500.000",
      "485.000",
      "-15.000",
    ]);
    expect(second.quantityChange).toBe("0.000");
    expect(await batchRow(ctx.a.id)).toMatchObject({ quantityAvailable: "500.000" });
  });

  test("bad drafts are field errors and need inventory.adjust", async ({ expect }) => {
    const ctx = await setup();
    const make = async (input, user = ctx.clerk) => {
      return await failure(createAdjustment(user, input, { now: NOW }));
    };

    expect((await make(draft(ctx), ctx.accountant)).status).toBe(403);
    expect(paths(await make({ ...draft(ctx), reason: "  " }))).toEqual(["reason"]);
    expect(paths(await make(draft(ctx, [])))).toEqual(["lines"]);
    expect(
      paths(
        await make(
          draft(ctx, [
            { inventoryBatchId: ctx.a.id, countedQuantity: "1" },
            { inventoryBatchId: ctx.a.id, countedQuantity: "2" },
            { inventoryBatchId: ctx.b.id, countedQuantity: "-1" },
            { inventoryBatchId: ctx.b.id, countedQuantity: "x" },
            { inventoryBatchId: ctx.north.batches[0].id, countedQuantity: "1" },
            { inventoryBatchId: ctx.a.id, countedQuantity: "501" },
          ]),
        ),
      ),
    ).toEqual([
      "lines.1.inventoryBatchId",
      "lines.2.countedQuantity",
      "lines.3.inventoryBatchId",
      "lines.3.countedQuantity",
      "lines.4.inventoryBatchId",
      "lines.5.inventoryBatchId",
      "lines.5.countedQuantity",
    ]);
  });

  test("a posted count books the variance as a movement and moves the on-hand total", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await approved(ctx);
    const result = await postAdjustment(ctx.manager, id, {}, { now: NOW });
    const [movement] = await db.select().from(inventoryMovements);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));

    expect(result.status).toBe("POSTED");
    expect(await batchRow(ctx.a.id)).toMatchObject({
      quantityAvailable: "485.000",
      status: "ACTIVE",
    });
    expect(await onHand(ctx)).toBe("525.000");
    expect(movement).toMatchObject({
      movementType: "STOCK_ADJUSTMENT",
      referenceType: "inventory_adjustment",
      referenceId: id,
      quantityChange: "-15.000",
      quantityBefore: "500.000",
      quantityAfter: "485.000",
    });
    expect(
      audits
        .map((row) => {
          return row.action;
        })
        .sort(),
    ).toEqual([
      "ADJUSTMENT_APPROVED",
      "ADJUSTMENT_CREATED",
      "ADJUSTMENT_POSTED",
      "ADJUSTMENT_SUBMITTED",
    ]);
    expect((await failure(postAdjustment(ctx.manager, id))).status).toBe(409);
  });

  test("counting more than recorded raises the batch up to what was received; zero depletes it", async ({
    expect,
  }) => {
    const ctx = await setup();

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "400.000" })
      .where(eq(inventoryBatches.id, ctx.a.id));
    await db.update(inventories).set({ quantityOnHand: "440.000" });

    const up = await approved(ctx, [{ inventoryBatchId: ctx.a.id, countedQuantity: "450" }]);

    await postAdjustment(ctx.manager, up, {}, { now: NOW });

    expect(await batchRow(ctx.a.id)).toMatchObject({ quantityAvailable: "450.000" });
    expect(await onHand(ctx)).toBe("490.000");

    const zero = await approved(ctx, [{ inventoryBatchId: ctx.b.id, countedQuantity: "0" }]);

    await postAdjustment(ctx.manager, zero, {}, { now: NOW });

    expect(await batchRow(ctx.b.id)).toMatchObject({
      quantityAvailable: "0.000",
      status: "DEPLETED",
    });
    expect(await onHand(ctx)).toBe("450.000");
  });

  test("approval is separate duty: permission, distinct approver, reasons on reject and cancel", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await createAdjustment(ctx.clerk, draft(ctx), { now: NOW });

    expect((await failure(approveAdjustment(ctx.manager, id))).status).toBe(409);
    await submitAdjustment(ctx.clerk, id);
    expect((await failure(approveAdjustment(ctx.clerk, id))).status).toBe(403);

    const own = await createAdjustment(ctx.manager, draft(ctx), { now: NOW });

    await submitAdjustment(ctx.manager, own.id);
    expect((await failure(approveAdjustment(ctx.manager, own.id))).status).toBe(403);
    expect((await failure(rejectAdjustment(ctx.manager, id, {}))).status).toBe(422);
    expect((await failure(cancelAdjustment(ctx.clerk, own.id, { reason: "" }))).status).toBe(422);

    await rejectAdjustment(ctx.manager, id, { reason: "Recount the shelf" });
    await cancelAdjustment(ctx.manager, own.id, { reason: "Entered twice" });

    expect((await getAdjustment(ctx.clerk, id)).adjustment.status).toBe("REJECTED");
    expect((await getAdjustment(ctx.clerk, own.id)).adjustment.status).toBe("CANCELLED");
    expect((await failure(postAdjustment(ctx.manager, id))).status).toBe(409);
  });

  test("a post is refused when the stock moved since the count, and changes nothing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await approved(ctx);

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "495.000" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    const error = await failure(postAdjustment(ctx.manager, id, {}, { now: NOW }));

    expect(error.status).toBe(409);
    expect(error.code).toBe("count_stale");
    expect((await getAdjustment(ctx.manager, id)).adjustment.status).toBe("APPROVED");
    expect(await batchRow(ctx.a.id)).toMatchObject({ quantityAvailable: "495.000" });
    expect(await db.select().from(inventoryMovements)).toHaveLength(0);

    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "500.000", status: "RECALLED" })
      .where(eq(inventoryBatches.id, ctx.a.id));

    expect((await failure(postAdjustment(ctx.manager, id))).code).toBe("count_stale");
  });

  test("two posts at once book the count once", async ({ expect }) => {
    const ctx = await setup();
    const id = await approved(ctx);
    const results = await Promise.allSettled([
      postAdjustment(ctx.manager, id, {}, { now: NOW }),
      postAdjustment(ctx.manager, id, {}, { now: NOW }),
    ]);

    expect(
      results.filter((result) => {
        return result.status === "fulfilled";
      }),
    ).toHaveLength(1);
    expect(await db.select().from(inventoryMovements)).toHaveLength(1);
    expect(await onHand(ctx)).toBe("525.000");
  });

  test("other branches cannot see or act; lists and the batch picker stay in branch", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await createAdjustment(ctx.clerk, draft(ctx), { now: NOW });

    expect((await failure(getAdjustment(ctx.stranger, id))).status).toBe(404);
    expect((await failure(submitAdjustment(ctx.stranger, id))).status).toBe(404);
    expect((await failure(getAdjustment(ctx.clerk, "nope"))).status).toBe(404);
    expect((await getAdjustment(ctx.accountant, id)).adjustment.id).toBe(id);
    expect((await listAdjustments(ctx.clerk, {})).total).toBe(1);
    expect((await listAdjustments(ctx.stranger, {})).total).toBe(0);
    expect((await listAdjustments(ctx.clerk, { status: "POSTED" })).total).toBe(0);
    expect(
      (await listCountableBatches(ctx.clerk))
        .map((row) => {
          return row.batchNumber;
        })
        .sort(),
    ).toEqual(["LOT-A", "LOT-B"]);
  });

  test("counting a quarantined batch to zero leaves it quarantined", async ({ expect }) => {
    const ctx = await setup();

    await db
      .update(inventoryBatches)
      .set({ status: "QUARANTINED" })
      .where(eq(inventoryBatches.id, ctx.b.id));

    const { id } = await createAdjustment(
      ctx.clerk,
      { reason: "Nothing left", lines: [{ inventoryBatchId: ctx.b.id, countedQuantity: "0" }] },
      { now: NOW },
    );

    await submitAdjustment(ctx.clerk, id, {}, { now: NOW });
    await approveAdjustment(ctx.manager, id, {}, { now: NOW });
    await postAdjustment(ctx.manager, id, {}, { now: NOW });

    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, ctx.b.id));

    expect(batch).toMatchObject({ status: "QUARANTINED", quantityAvailable: "0.000" });
  });
});
