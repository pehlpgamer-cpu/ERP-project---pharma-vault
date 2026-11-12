import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db, pool } from "../../database/client.js";
import { HttpError, ValidationError } from "../../app/http/errors.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import {
  quarantineBatch,
  recallBatch,
  releaseBatch,
  writeOffBatch,
} from "../../app/services/inventory/batchActions.js";
import { createSale } from "../../app/services/sales/checkout.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct, makeWorld } from "../helpers/factories.js";

const NOW = new Date("2026-11-12T03:00:00Z");

async function setup({ quantity = "10.000" } = {}) {
  const world = await makeWorld();
  const manager = await makeAuthUser({
    branchId: world.branch.id,
    roleName: "pharmacist-batches",
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const stocked = await makeProduct({
    branchId: world.branch.id,
    name: "Syrup",
    units: [{ name: "Tablet", factor: "1", base: true, price: "3.5000" }],
    batches: [{ quantity, batchNumber: "B1", expirationDate: "2030-01-31", unitCost: "1.2000" }],
  });

  return {
    world,
    manager,
    cashier: await loadAuthUser(world.cashier.id),
    product: stocked.product,
    unit: stocked.units[0],
    batch: stocked.batches[0],
  };
}

const row = async (id) => {
  const [batch] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, id));

  return batch;
};

const onHand = async (productId) => {
  const [inventory] = await db
    .select()
    .from(inventories)
    .where(eq(inventories.productId, productId));

  return inventory.quantityOnHand;
};

async function totals() {
  const [[counts]] = await pool.query(`SELECT
    (SELECT COUNT(*) FROM inventory_movements) AS movements,
    (SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'inventory_batch') AS audits`);

  return { movements: Number(counts.movements), audits: Number(counts.audits) };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return null;
}

const sell = (ctx, quantity = "1.000") => {
  return createSale(
    ctx.cashier,
    {
      items: [{ productUnitId: ctx.unit.id, quantity }],
      payments: [{ method: "CASH", amount: "100.00", reference: null }],
      customerId: null,
    },
    randomUUID(),
    { now: NOW },
  );
};

test.group("quarantine, release and recall", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("quarantine and release move a batch out of and back into sale, with audit rows", async ({
    expect,
  }) => {
    const ctx = await setup();

    expect(
      await quarantineBatch(ctx.manager, ctx.batch.id, { reason: "Suspect seal" }, { now: NOW }),
    ).toEqual({ batchId: ctx.batch.id, status: "QUARANTINED" });
    expect((await row(ctx.batch.id)).status).toBe("QUARANTINED");
    expect((await failure(sell(ctx))).code).toBe("insufficient_stock");

    expect(await releaseBatch(ctx.manager, ctx.batch.id, { reason: "Cleared by QA" })).toEqual({
      batchId: ctx.batch.id,
      status: "ACTIVE",
    });
    expect((await sell(ctx)).replayed).toBe(false);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, ctx.batch.id));
    const quarantined = audits.find((audit) => {
      return audit.action === "BATCH_QUARANTINED";
    });

    const actions = audits.map((audit) => {
      return audit.action;
    });

    expect(actions.sort()).toEqual(["BATCH_QUARANTINED", "BATCH_RELEASED"]);
    expect(quarantined).toMatchObject({
      entityType: "inventory_batch",
      userId: ctx.manager.id,
      reason: "Suspect seal",
    });
    expect(quarantined.oldValues.status).toBe("ACTIVE");
    expect(quarantined.newValues.status).toBe("QUARANTINED");
    expect(await onHand(ctx.product.id)).toBe("9.000");
  });

  test("a recalled batch is never sold and cannot be released", async ({ expect }) => {
    const ctx = await setup();
    await quarantineBatch(ctx.manager, ctx.batch.id, { reason: "Hold" });

    await recallBatch(ctx.manager, ctx.batch.id, { reason: "Manufacturer recall 22-41" });

    expect((await row(ctx.batch.id)).status).toBe("RECALLED");
    expect((await failure(sell(ctx))).code).toBe("insufficient_stock");
    expect((await failure(releaseBatch(ctx.manager, ctx.batch.id, { reason: "oops" }))).code).toBe(
      "batch_state",
    );
  });

  test("a transition that is not allowed is a 409 batch_state and changes nothing (review focus 4)", async ({
    expect,
  }) => {
    const ctx = await setup();
    const other = await makeProduct({
      branchId: ctx.world.branch.id,
      name: "Other",
      batches: [
        { quantity: "5", batchNumber: "Q", status: "QUARANTINED" },
        { quantity: "5", batchNumber: "R", status: "RECALLED" },
        { quantity: "0", batchNumber: "D", status: "DEPLETED" },
      ],
    });
    const [quarantined, recalled, depleted] = other.batches;
    const before = await totals();
    const refused = [
      () => {
        return quarantineBatch(ctx.manager, quarantined.id, { reason: "x" });
      },
      () => {
        return quarantineBatch(ctx.manager, recalled.id, { reason: "x" });
      },
      () => {
        return releaseBatch(ctx.manager, ctx.batch.id, { reason: "x" });
      },
      () => {
        return releaseBatch(ctx.manager, recalled.id, { reason: "x" });
      },
      () => {
        return recallBatch(ctx.manager, recalled.id, { reason: "x" });
      },
      () => {
        return recallBatch(ctx.manager, depleted.id, { reason: "x" });
      },
      () => {
        return writeOffBatch(ctx.manager, recalled.id, { reason: "x", kind: "damaged" });
      },
      () => {
        return writeOffBatch(ctx.manager, depleted.id, { reason: "x", kind: "damaged" });
      },
    ];

    for (const attempt of refused) {
      const error = await failure(attempt());

      expect([error.status, error.code]).toEqual([409, "batch_state"]);
    }

    expect(await totals()).toEqual(before);
    expect((await row(ctx.batch.id)).status).toBe("ACTIVE");
  });
});

test.group("write off", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("an expired write-off empties the batch, writes a movement and lowers on hand", async ({
    expect,
  }) => {
    const ctx = await setup();

    const result = await writeOffBatch(
      ctx.manager,
      ctx.batch.id,
      { reason: "Past its date", kind: "expired" },
      { now: NOW },
    );
    const [movement] = await db.select().from(inventoryMovements);

    expect(result).toEqual({ batchId: ctx.batch.id, status: "EXPIRED" });
    expect(await row(ctx.batch.id)).toMatchObject({
      quantityAvailable: "0.000",
      status: "EXPIRED",
    });
    expect(await onHand(ctx.product.id)).toBe("0.000");
    expect(movement).toMatchObject({
      branchId: ctx.world.branch.id,
      productId: ctx.product.id,
      inventoryBatchId: ctx.batch.id,
      movementType: "EXPIRED",
      quantityChange: "-10.000",
      quantityBefore: "10.000",
      quantityAfter: "0.000",
      unitCost: "1.2000",
      performedBy: ctx.manager.id,
      reason: "Past its date",
    });
    expect((await failure(sell(ctx))).code).toBe("insufficient_stock");
  });

  test("a damaged write-off ends DEPLETED with a DAMAGED movement, and a quarantined batch can be written off", async ({
    expect,
  }) => {
    const ctx = await setup();
    await quarantineBatch(ctx.manager, ctx.batch.id, { reason: "Water damage" });

    const result = await writeOffBatch(ctx.manager, ctx.batch.id, {
      reason: "Destroyed",
      kind: "damaged",
    });
    const movements = await db.select().from(inventoryMovements);

    expect(result.status).toBe("DEPLETED");
    expect(movements).toHaveLength(1);
    expect(movements[0].movementType).toBe("DAMAGED");
    expect(movements[0].quantityChange).toBe("-10.000");
  });

  test("a write-off after a partial sale only removes what is left", async ({ expect }) => {
    const ctx = await setup();
    await sell(ctx, "4.000");

    await writeOffBatch(ctx.manager, ctx.batch.id, { reason: "Expired", kind: "expired" });

    const movements = await db.select().from(inventoryMovements);
    const writeOff = movements.find((movement) => {
      return movement.movementType === "EXPIRED";
    });

    expect(writeOff).toMatchObject({ quantityBefore: "6.000", quantityAfter: "0.000" });
    expect(await onHand(ctx.product.id)).toBe("0.000");
  });

  test("a write-off racing a sale for the same stock keeps on hand equal to the batches (review focus 1)", async ({
    expect,
  }) => {
    for (let round = 0; round < 5; round += 1) {
      await resetDatabase();
      const ctx = await setup({ quantity: "10.000" });

      const results = await Promise.allSettled([
        sell(ctx, "10.000"),
        writeOffBatch(ctx.manager, ctx.batch.id, { reason: "Expired", kind: "expired" }),
      ]);
      const [[sums]] = await pool.query(
        "SELECT (SELECT quantity_on_hand FROM inventories WHERE product_id = ?) AS onHand, (SELECT SUM(quantity_available) FROM inventory_batches WHERE product_id = ?) AS batches",
        [ctx.product.id, ctx.product.id],
      );

      expect([
        round,
        results.filter((result) => {
          return result.status === "fulfilled";
        }).length,
      ]).toEqual([round, 1]);
      expect([round, sums.onHand, sums.batches]).toEqual([round, "0.000", "0.000"]);
    }
  });
});

test.group("reasons, kinds and scope", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a missing, blank or over-long reason, or a bad kind, is a 422 that changes nothing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const before = await totals();

    for (const reason of [undefined, "", "   ", "x".repeat(501), 5]) {
      const error = await failure(quarantineBatch(ctx.manager, ctx.batch.id, { reason }));

      expect([reason, error instanceof ValidationError]).toEqual([reason, true]);
    }

    for (const kind of [undefined, "lost", "EXPIRED"]) {
      const error = await failure(writeOffBatch(ctx.manager, ctx.batch.id, { reason: "ok", kind }));

      expect([kind, error instanceof ValidationError]).toEqual([kind, true]);
    }

    expect(await totals()).toEqual(before);
    expect((await row(ctx.batch.id)).status).toBe("ACTIVE");
  });

  test("another branch's batch is a 404 for a pharmacist and allowed for the all-branch scope (review focus 3)", async ({
    expect,
  }) => {
    const ctx = await setup();
    const north = await makeBranch({ code: "NORTH" });
    const northStock = await makeProduct({
      branchId: north.id,
      name: "Northern",
      batches: [{ quantity: "5", batchNumber: "N1" }],
    });
    const admin = await makeAuthUser({
      branchId: ctx.world.branch.id,
      roleName: "admin-batches",
      permissions: ROLE_PERMISSIONS.admin,
    });
    const [batch] = northStock.batches;

    const denied = await failure(quarantineBatch(ctx.manager, batch.id, { reason: "x" }));

    expect([denied.status, denied.code]).toEqual([404, "not_found"]);
    expect((await row(batch.id)).status).toBe("ACTIVE");
    expect((await quarantineBatch(admin, batch.id, { reason: "audit" })).status).toBe(
      "QUARANTINED",
    );
  });

  test("unknown and malformed ids are a 404, never a 500", async ({ expect }) => {
    const ctx = await setup();

    for (const id of [randomUUID(), "not-a-uuid", "é", undefined]) {
      const error = await failure(quarantineBatch(ctx.manager, id, { reason: "x" }));

      expect([id, error instanceof HttpError, error?.status]).toEqual([id, true, 404]);
    }
  });
});
