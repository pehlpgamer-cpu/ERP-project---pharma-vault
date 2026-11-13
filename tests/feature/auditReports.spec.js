import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { inventoryMovements } from "../../app/models/inventory-movements.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { listAuditEvents, redact } from "../../app/services/audit/auditQuery.js";
import { listMovements } from "../../app/services/inventory/movementLedger.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

const audit = (values) => {
  return db.insert(auditLogs).values({
    id: randomUUID(),
    action: "SALE_COMPLETED",
    entityType: "sale",
    createdAt: new Date("2026-11-12T03:00:00Z"),
    ...values,
  });
};

async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const admin = await makeUser({
    branchId: main.id,
    roleName: "admin-audit",
    permissions: ROLE_PERMISSIONS.admin,
    name: "Alice Admin",
  });
  const clerk = await makeUser({
    branchId: main.id,
    roleName: "clerk-audit",
    permissions: ROLE_PERMISSIONS.pharmacist,
    name: "Pia Pharmacist",
  });
  const northClerk = await makeUser({
    branchId: north.id,
    roleName: "north-audit",
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const accountant = await makeUser({
    branchId: main.id,
    roleName: "acct-audit",
    permissions: ROLE_PERMISSIONS.accountant,
  });
  const cashier = await makeUser({
    branchId: main.id,
    roleName: "cash-audit",
    permissions: ROLE_PERMISSIONS.cashier,
  });
  const stock = await makeProduct({
    branchId: main.id,
    name: "Amoxicillin 500 mg",
    units: [{ name: "Capsule", factor: "1", base: true }],
    batches: [{ quantity: "100", batchNumber: "AMOX-7" }],
  });
  const northStock = await makeProduct({
    branchId: north.id,
    name: "Cetirizine 10 mg",
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "50", batchNumber: "CETI-2" }],
  });

  return { main, north, admin, clerk, northClerk, accountant, cashier, stock, northStock };
}

const movement = (batch, branchId, productId, values) => {
  return db.insert(inventoryMovements).values({
    id: randomUUID(),
    branchId,
    productId,
    inventoryBatchId: batch.id,
    movementType: "SALE",
    quantityChange: "-5.000",
    quantityBefore: "100.000",
    quantityAfter: "95.000",
    unitCost: "1.0000",
    performedBy: values.performedBy,
    createdAt: new Date("2026-11-12T03:00:00Z"),
    ...values,
  });
};

test.group("audit trail", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("redact hides secrets at any depth and leaves the rest", ({ expect }) => {
    expect(
      redact({
        password: "hunter2",
        ok: 1,
        nested: { cardNumber: "4111", token: "abc", list: [{ apiSecret: "s", fine: "yes" }] },
        PIN: "1234",
      }),
    ).toEqual({
      password: "[redacted]",
      ok: 1,
      nested: {
        cardNumber: "[redacted]",
        token: "[redacted]",
        list: [{ apiSecret: "[redacted]", fine: "yes" }],
      },
      PIN: "[redacted]",
    });
    expect(redact(null)).toBeNull();
    expect(redact("plain")).toBe("plain");
  });

  test("only audit.view may read it, and it filters and pages", async ({ expect }) => {
    const ctx = await setup();
    const adminUser = await makeAuthUser({
      branchId: ctx.main.id,
      permissions: ROLE_PERMISSIONS.admin,
    });
    const clerkUser = await makeAuthUser({
      branchId: ctx.main.id,
      permissions: ROLE_PERMISSIONS.pharmacist,
    });
    const saleId = randomUUID();

    await audit({ userId: ctx.admin.id, branchId: ctx.main.id, entityId: saleId, reason: "r1" });
    await audit({
      userId: ctx.clerk.id,
      branchId: ctx.north.id,
      action: "RETURN_CREATED",
      entityType: "sales_return",
      createdAt: new Date("2026-11-10T03:00:00Z"),
    });
    await audit({
      userId: ctx.clerk.id,
      action: "RETURN_PROCESSED",
      entityType: "sales_return",
      createdAt: new Date("2026-11-11T03:00:00Z"),
    });

    expect((await failure(listAuditEvents(clerkUser, {}))).status).toBe(403);
    expect((await listAuditEvents(adminUser, {})).total).toBe(3);
    expect((await listAuditEvents(adminUser, { action: "RETURN" })).total).toBe(2);
    expect((await listAuditEvents(adminUser, { entityType: "sale" })).total).toBe(1);
    expect((await listAuditEvents(adminUser, { entityId: saleId })).total).toBe(1);
    expect((await listAuditEvents(adminUser, { entityId: "nope" })).total).toBe(0);
    expect((await listAuditEvents(adminUser, { from: "2026-11-11", to: "2026-11-11" })).total).toBe(
      1,
    );
    expect((await listAuditEvents(adminUser, { q: "pia" })).total).toBe(2);
    expect((await listAuditEvents(adminUser, { q: "%" })).total).toBe(0);

    const all = await listAuditEvents(adminUser, {});

    expect(all.rows[0]).toMatchObject({
      action: "SALE_COMPLETED",
      userName: "Alice Admin",
      branchName: ctx.main.name,
    });
    expect(all.entityTypes).toEqual(["sale", "sales_return"]);
    expect((await listAuditEvents(adminUser, { page: 99 })).rows).toHaveLength(0);
  });

  test("the page links entities, redacts values and escapes everything", async ({ expect }) => {
    const ctx = await setup();
    const admin = await loginAs(ctx.admin);
    const saleId = randomUUID();

    await audit({
      userId: ctx.admin.id,
      branchId: ctx.main.id,
      entityId: saleId,
      reason: XSS,
      newValues: { total: "10.00", password: "hunter2", note: XSS },
    });

    const page = await admin.get("/audit", HTML);

    expect(page.status).toBe(200);
    expect(page.text).toContain(`/sales/${saleId}`);
    expect(page.text).toContain("[redacted]");
    expect(page.text).not.toContain("hunter2");
    expect(page.text).not.toContain(XSS);
    expect(page.text).toContain("&lt;img src");
    expect(
      (await admin.get("/audit?entityType=sale&from=2026-11-12&to=2026-11-12", HTML)).text,
    ).toContain("SALE_COMPLETED");
    expect((await admin.get("/audit?entityType=sale&from=2026-11-13", HTML)).text).not.toContain(
      "SALE_COMPLETED",
    );
    expect((await admin.get("/audit?page=99999999999999999999&from=bad", HTML)).status).toBe(200);

    for (const who of [ctx.clerk, ctx.accountant, ctx.cashier]) {
      expect((await (await loginAs(who)).get("/audit", HTML)).status).toBe(403);
    }

    expect((await new TestSession().get("/audit", HTML)).location).toBe("/login-page");
  });
});

test.group("stock movement ledger", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a branch user sees their own branch, an all-branch user may pick one", async ({
    expect,
  }) => {
    const ctx = await setup();
    const clerk = await makeAuthUser({
      branchId: ctx.main.id,
      permissions: ROLE_PERMISSIONS.pharmacist,
    });
    const admin = await makeAuthUser({
      branchId: ctx.main.id,
      permissions: ROLE_PERMISSIONS.admin,
    });
    const saleId = randomUUID();

    await movement(ctx.stock.batches[0], ctx.main.id, ctx.stock.product.id, {
      performedBy: ctx.clerk.id,
      referenceType: "sale",
      referenceId: saleId,
    });
    await movement(ctx.stock.batches[0], ctx.main.id, ctx.stock.product.id, {
      performedBy: ctx.clerk.id,
      movementType: "STOCK_ADJUSTMENT",
      quantityChange: "2.000",
      quantityBefore: "95.000",
      quantityAfter: "97.000",
      createdAt: new Date("2026-11-10T03:00:00Z"),
    });
    await movement(ctx.northStock.batches[0], ctx.north.id, ctx.northStock.product.id, {
      performedBy: ctx.northClerk.id,
    });

    expect((await listMovements(clerk, {})).total).toBe(2);
    expect((await listMovements(clerk, { branchId: ctx.north.id })).total).toBe(2);
    expect((await listMovements(admin, {})).total).toBe(3);
    expect((await listMovements(admin, { branchId: ctx.north.id })).total).toBe(1);
    expect((await listMovements(admin, { type: "STOCK_ADJUSTMENT" })).total).toBe(1);
    expect((await listMovements(admin, { type: "NOT_A_TYPE" })).total).toBe(3);
    expect((await listMovements(admin, { q: "amox" })).total).toBe(2);
    expect((await listMovements(admin, { q: "AMOX-7" })).total).toBe(2);
    expect((await listMovements(admin, { q: ctx.stock.product.sku })).total).toBe(2);
    expect((await listMovements(admin, { from: "2026-11-12", to: "2026-11-12" })).total).toBe(2);

    const all = await listMovements(admin, { type: "SALE", branchId: ctx.main.id });

    expect(all.rows[0]).toMatchObject({
      productName: "Amoxicillin 500 mg",
      batchNumber: "AMOX-7",
      movementType: "SALE",
      quantityChange: "-5.000",
      quantityAfter: "95.000",
      referenceId: saleId,
    });
  });

  test("the page needs inventory.view, links the source and escapes the reason", async ({
    expect,
  }) => {
    const ctx = await setup();
    const saleId = randomUUID();

    await movement(ctx.stock.batches[0], ctx.main.id, ctx.stock.product.id, {
      performedBy: ctx.clerk.id,
      referenceType: "sale",
      referenceId: saleId,
      reason: XSS,
    });

    const clerk = await loginAs(ctx.clerk);
    const page = await clerk.get("/reports/movements", HTML);

    expect(page.status).toBe(200);
    expect(page.text).toContain("AMOX-7");
    expect(page.text).toContain(`/sales/${saleId}`);
    expect(page.text).not.toContain(XSS);
    expect((await (await loginAs(ctx.accountant)).get("/reports/movements", HTML)).status).toBe(
      200,
    );
    expect((await (await loginAs(ctx.cashier)).get("/reports/movements", HTML)).status).toBe(403);
    expect((await new TestSession().get("/reports/movements", HTML)).location).toBe("/login-page");
    expect(
      (
        await clerk.get(
          "/reports/movements?type=SALE&q=amox&from=2026-11-12&to=2026-11-12&page=0",
          HTML,
        )
      ).status,
    ).toBe(200);
  });
});
