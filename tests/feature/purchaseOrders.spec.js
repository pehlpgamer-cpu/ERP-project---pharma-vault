import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { productUnits } from "../../app/models/product-units.js";
import { purchaseOrderItems } from "../../app/models/purchase-order-items.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  returnPurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
} from "../../app/services/purchasing/purchaseOrders.js";
import { createSupplier, updateSupplier } from "../../app/services/purchasing/suppliers.js";
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

async function setup() {
  const branch = await makeBranch({ code: "MAIN" });
  const other = await makeBranch({ code: "NORTH" });
  const buyer = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const manager = await makeAuthUser({ branchId: branch.id, permissions: ROLE_PERMISSIONS.admin });
  const stranger = await makeAuthUser({
    branchId: other.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const supplier = await createSupplier(buyer, { code: "ACME", name: "Acme Pharma" });
  const { product, units } = await makeProduct({
    units: [
      { name: "Tablet", factor: "1", base: true },
      { name: "Box", factor: "100" },
    ],
  });

  return { branch, buyer, manager, stranger, supplierId: supplier.id, product, units };
}

const draft = (ctx, lines) => {
  return {
    supplierId: ctx.supplierId,
    notes: "Weekly order",
    lines: lines ?? [{ productUnitId: ctx.units[1].id, quantity: "10", unitCost: "250.5" }],
  };
};

const created = async (ctx, lines) => {
  return (await createPurchaseOrder(ctx.buyer, draft(ctx, lines), { now: NOW })).id;
};

test.group("purchase orders", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("create writes a DRAFT with a numbered header, snapshotted lines and exact totals", async ({
    expect,
  }) => {
    const ctx = await setup();
    const first = await createPurchaseOrder(
      ctx.buyer,
      draft(ctx, [
        { productUnitId: ctx.units[1].id, quantity: "10", unitCost: "250.5" },
        { productUnitId: ctx.units[0].id, quantity: "3.333", unitCost: "0.0333" },
      ]),
      { now: NOW },
    );
    const second = await createPurchaseOrder(ctx.buyer, draft(ctx), { now: NOW });
    const { order, lines } = await getPurchaseOrder(ctx.buyer, first.id);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, first.id));

    expect([first.poNumber, second.poNumber]).toEqual([
      "PO-MAIN-20261112-0001",
      "PO-MAIN-20261112-0002",
    ]);
    expect(order).toMatchObject({
      status: "DRAFT",
      branchId: ctx.branch.id,
      supplierName: "Acme Pharma",
      total: "2505.11",
      createdBy: ctx.buyer.id,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      quantityOrdered: "10.000",
      quantityReceived: "0.000",
      unitCost: "250.5000",
      lineTotal: "2505.00",
      conversionFactor: "100.000",
    });
    expect(lines[1].lineTotal).toBe("0.11");
    expect(audit.action).toBe("PO_CREATED");
  });

  test("bad input is refused with one message per field and nothing is written", async ({
    expect,
  }) => {
    const ctx = await setup();
    const [, boxOnly] = ctx.units;
    const noLines = await failure(createPurchaseOrder(ctx.buyer, draft(ctx, []), { now: NOW }));
    const bad = await failure(
      createPurchaseOrder(
        ctx.buyer,
        {
          supplierId: "nope",
          lines: [
            { productUnitId: boxOnly.id, quantity: "0", unitCost: "1" },
            { productUnitId: boxOnly.id, quantity: "1.0001", unitCost: "-1" },
            { productUnitId: "nope", quantity: "x", unitCost: "1" },
          ],
        },
        { now: NOW },
      ),
    );

    await db
      .update(productUnits)
      .set({ canBePurchased: false })
      .where(eq(productUnits.id, boxOnly.id));

    const notBuyable = await failure(createPurchaseOrder(ctx.buyer, draft(ctx), { now: NOW }));

    expect(noLines.details[0].path).toBe("lines");
    expect(
      bad.details.map((detail) => {
        return detail.path;
      }),
    ).toEqual([
      "supplierId",
      "lines.0.quantity",
      "lines.1.quantity",
      "lines.1.unitCost",
      "lines.1.productUnitId",
      "lines.2.productUnitId",
      "lines.2.quantity",
    ]);
    expect(notBuyable.details[0].path).toBe("lines.0.productUnitId");
    expect(await db.select().from(purchaseOrderItems)).toHaveLength(0);
  });

  test("an inactive or unknown supplier cannot be ordered from, and a user without a branch cannot order", async ({
    expect,
  }) => {
    const ctx = await setup();

    await updateSupplier(ctx.buyer, ctx.supplierId, {
      code: "ACME",
      name: "Acme Pharma",
      isActive: false,
    });

    const inactive = await failure(createPurchaseOrder(ctx.buyer, draft(ctx), { now: NOW }));
    const floating = await makeAuthUser({ permissions: ROLE_PERMISSIONS.pharmacist });
    const noBranch = await failure(createPurchaseOrder(floating, draft(ctx), { now: NOW }));

    expect(inactive.details[0].path).toBe("supplierId");
    expect([noBranch.status, noBranch.code]).toEqual([403, "forbidden"]);
  });

  test("only a draft can be edited, and an edit replaces the lines and the total", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await created(ctx);

    await updatePurchaseOrder(
      ctx.buyer,
      id,
      draft(ctx, [{ productUnitId: ctx.units[0].id, quantity: "5", unitCost: "2" }]),
    );

    const { order, lines } = await getPurchaseOrder(ctx.buyer, id);

    await submitPurchaseOrder(ctx.buyer, id);

    const locked = await failure(updatePurchaseOrder(ctx.buyer, id, draft(ctx)));

    expect(lines).toHaveLength(1);
    expect(order.total).toBe("10.00");
    expect([locked.status, locked.code]).toEqual([409, "po_state"]);
  });

  test("the lifecycle runs submit, approve, send; return reopens; every move is audited", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await created(ctx);

    await submitPurchaseOrder(ctx.buyer, id);
    await returnPurchaseOrder(ctx.manager, id, { reason: "price check" });
    await submitPurchaseOrder(ctx.buyer, id);

    const denied = await failure(approvePurchaseOrder(ctx.buyer, id));
    const early = await failure(sendPurchaseOrder(ctx.buyer, id));

    await approvePurchaseOrder(ctx.manager, id);
    await sendPurchaseOrder(ctx.buyer, id);

    const { order } = await getPurchaseOrder(ctx.buyer, id);
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id))).map(
      (row) => {
        return row.action;
      },
    );

    expect([denied.status, early.status, early.code]).toEqual([403, 409, "po_state"]);
    expect(order).toMatchObject({ status: "SENT", approvedBy: ctx.manager.id });
    expect(order.sentAt).not.toBeNull();
    expect(actions.sort()).toEqual([
      "PO_APPROVED",
      "PO_CREATED",
      "PO_RETURNED",
      "PO_SENT",
      "PO_SUBMITTED",
      "PO_SUBMITTED",
    ]);
  });

  test("cancel works until the order is sent; send and close need the right state and supplier", async ({
    expect,
  }) => {
    const ctx = await setup();
    const a = await created(ctx);
    const b = await created(ctx);
    const c = await created(ctx);

    await cancelPurchaseOrder(ctx.buyer, a, { reason: "not needed" });
    await submitPurchaseOrder(ctx.buyer, b);
    await cancelPurchaseOrder(ctx.buyer, b, { reason: "not needed" });
    await submitPurchaseOrder(ctx.buyer, c);
    await approvePurchaseOrder(ctx.manager, c);
    await updateSupplier(ctx.manager, ctx.supplierId, {
      code: "ACME",
      name: "Acme Pharma",
      isActive: false,
    });

    const sendInactive = await failure(sendPurchaseOrder(ctx.buyer, c));

    await updateSupplier(ctx.manager, ctx.supplierId, {
      code: "ACME",
      name: "Acme Pharma",
      isActive: true,
    });
    await sendPurchaseOrder(ctx.buyer, c);

    const cancelSent = await failure(cancelPurchaseOrder(ctx.buyer, c, { reason: "late" }));
    const closeSent = await failure(closePurchaseOrder(ctx.buyer, c));
    const cancelTwice = await failure(cancelPurchaseOrder(ctx.buyer, a, { reason: "again" }));
    const noReason = await failure(cancelPurchaseOrder(ctx.buyer, await created(ctx), {}));

    expect(
      [sendInactive, cancelSent, closeSent, cancelTwice].map((error) => {
        return [error.status, error.code];
      }),
    ).toEqual([
      [409, "supplier_inactive"],
      [409, "po_state"],
      [409, "po_state"],
      [409, "po_state"],
    ]);
    expect(noReason.details[0].path).toBe("reason");
  });

  test("two approvals at once: one wins, the other is a 409", async ({ expect }) => {
    const ctx = await setup();
    const id = await created(ctx);

    await submitPurchaseOrder(ctx.buyer, id);

    const results = await Promise.allSettled([
      approvePurchaseOrder(ctx.manager, id),
      approvePurchaseOrder(ctx.manager, id),
    ]);
    const failed = results.filter((result) => {
      return result.status === "rejected";
    });

    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe("po_state");
    expect(
      (await db.select().from(auditLogs).where(eq(auditLogs.action, "PO_APPROVED"))).length,
    ).toBe(1);
  });

  test("another branch gets 404 for reads and actions; the all-branch scope may read", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await created(ctx);
    const accountant = await makeAuthUser({
      branchId: ctx.stranger.branchId,
      permissions: ROLE_PERMISSIONS.accountant,
    });
    const read = await failure(getPurchaseOrder(ctx.stranger, id));
    const act = await failure(submitPurchaseOrder(ctx.stranger, id));
    const unknown = await failure(
      getPurchaseOrder(ctx.buyer, "00000000-0000-4000-8000-000000000000"),
    );

    expect([read.status, act.status, unknown.status]).toEqual([404, 404, 404]);
    expect((await getPurchaseOrder(accountant, id)).order.id).toBe(id);
    expect((await listPurchaseOrders(ctx.stranger)).rows).toHaveLength(0);
    expect((await listPurchaseOrders(accountant)).rows).toHaveLength(1);
    expect((await listPurchaseOrders(ctx.buyer, { status: "SENT" })).rows).toHaveLength(0);
    expect((await listPurchaseOrders(ctx.buyer, { status: "DRAFT" })).rows).toHaveLength(1);
  });
});
