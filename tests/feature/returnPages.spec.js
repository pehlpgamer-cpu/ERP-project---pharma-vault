import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventories } from "../../app/models/inventories.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { saleItemBatches } from "../../app/models/sale-item-batches.js";
import { sales } from "../../app/models/sales.js";
import { salesReturns } from "../../app/models/sales-returns.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeOpenSession,
  makeRegister,
  makeSale,
  makeUser,
  makeWorld,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

// one 10-tablet, 100.00 cash sale in MAIN with the stock already off the shelf
async function setup() {
  const world = await makeWorld();
  const north = await makeBranch({ code: "NORTH" });
  const person = async (roleName, permissions, branchId = world.branch.id) => {
    return await makeUser({ roleName, permissions, branchId });
  };
  const manager = await person("manager-returns", ROLE_PERMISSIONS.admin);
  const register = await makeRegister({ branchId: world.branch.id });
  const sale = await makeSale({
    branchId: world.branch.id,
    cashierId: world.cashier.id,
    sessionId: world.session.id,
    lines: [
      {
        productId: world.product.id,
        productUnitId: world.unit.id,
        quantity: "10",
        unitPrice: "10.00",
        batches: [{ batchId: world.batch.id, quantity: "10" }],
      },
    ],
    payments: [{ method: "CASH", amount: "100.00" }],
  });

  await makeOpenSession({ registerId: register.id, cashierId: manager.id });
  await db
    .update(inventoryBatches)
    .set({ quantityAvailable: "99990.000" })
    .where(eq(inventoryBatches.id, world.batch.id));
  await db.update(inventories).set({ quantityOnHand: "99990.000" });

  const [piece] = await db.select().from(saleItemBatches);

  return {
    ...world,
    sale,
    piece,
    clerk: await loginAs(await person("clerk-returns", ROLE_PERMISSIONS.pharmacist)),
    admin: await loginAs(manager),
    cashierSession: await loginAs(world.cashier),
    accountant: await loginAs(await person("accountant-returns", ROLE_PERMISSIONS.accountant)),
    stranger: await loginAs(
      await person("stranger-returns", ROLE_PERMISSIONS.pharmacist, north.id),
    ),
  };
}

const returnForm = (ctx, overrides = {}) => {
  return {
    reason: "Wrong strength",
    "lines[0][saleItemBatchId]": ctx.piece.id,
    "lines[0][quantity]": "4",
    "lines[0][disposition]": "RESTOCK",
    ...overrides,
  };
};

const draftIn = async (ctx) => {
  const saved = await ctx.clerk.post(`/sales/${ctx.sale.id}/returns`, {
    ...HTML,
    form: returnForm(ctx),
  });

  return saved.location.split("/").pop();
};

const batchQuantity = async (ctx) => {
  const [row] = await db
    .select()
    .from(inventoryBatches)
    .where(eq(inventoryBatches.id, ctx.batch.id));

  return row.quantityAvailable;
};

test.group("return pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("starting needs returns.create, approving needs returns.approve, other branches see nothing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);
    const form = `/sales/${ctx.sale.id}/return`;

    expect((await ctx.cashierSession.get(form, HTML)).status).toBe(200);
    expect((await ctx.clerk.get(form, HTML)).status).toBe(200);
    expect((await ctx.accountant.get(form, HTML)).status).toBe(403);
    expect((await ctx.accountant.get("/returns", HTML)).status).toBe(403);
    expect((await ctx.accountant.get(`/returns/${id}`, HTML)).status).toBe(403);
    expect((await new TestSession().get("/returns", HTML)).location).toBe("/login-page");
    expect((await ctx.stranger.get(form, HTML)).status).toBe(404);
    expect((await ctx.stranger.get(`/returns/${id}`, HTML)).status).toBe(404);
    expect((await ctx.clerk.get("/returns/not-an-id", HTML)).status).toBe(404);
    expect((await ctx.cashierSession.post(`/returns/${id}/approve`, HTML)).status).toBe(403);
    expect((await ctx.cashierSession.post(`/returns/${id}/process`, HTML)).status).toBe(403);
  });

  test("the sale page offers a return only to people who can start one", async ({ expect }) => {
    const ctx = await setup();
    const path = `/sales/${ctx.sale.id}`;

    expect((await ctx.cashierSession.get(path, HTML)).text).toContain("Return items");
    expect((await ctx.accountant.get(path, HTML)).text).not.toContain("Return items");

    await db.update(sales).set({ status: "VOIDED" }).where(eq(sales.id, ctx.sale.id));

    expect((await ctx.cashierSession.get(path, HTML)).text).not.toContain("Return items");
  });

  test("a refused form keeps what was typed and escapes it; a saved one is listed", async ({
    expect,
  }) => {
    const ctx = await setup();
    const blank = await ctx.clerk.get(`/sales/${ctx.sale.id}/return`, HTML);
    const refused = await ctx.clerk.post(`/sales/${ctx.sale.id}/returns`, {
      ...HTML,
      form: returnForm(ctx, { reason: XSS, "lines[0][quantity]": "11" }),
    });
    const id = await draftIn(ctx);
    const list = await ctx.clerk.get("/returns?status=DRAFT", HTML);
    const page = await ctx.clerk.get(`/returns/${id}`, HTML);

    expect(blank.status).toBe(200);
    expect(blank.text).toContain("PARA-MAIN");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Only 10.000 left");
    expect(refused.text).not.toContain(XSS);
    expect(refused.text).toContain('value="11"');
    expect(list.text).toContain("RET-");
    expect(page.text).toContain("Wrong strength");
    expect(page.text).toContain("40.00");
    expect(page.text).toContain("Submit for approval");
    expect((await ctx.clerk.get("/returns?page=99999999999999999999", HTML)).status).toBe(200);
  });

  test("the whole flow: submit, a different person approves and processes, stock and sale follow", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.clerk.post(`/returns/${id}/submit`, HTML);

    const pending = await ctx.admin.get(`/returns/${id}`, HTML);

    await ctx.admin.post(`/returns/${id}/approve`, HTML);

    const ready = await ctx.admin.get(`/returns/${id}`, HTML);

    expect(pending.text).toContain("Approve");
    expect(ready.text).toContain("Process return");
    expect(ready.text).toContain("up to");
    expect(ready.text).toContain('name="refunds[0][amount]" value="40.00"');

    await ctx.admin.post(`/returns/${id}/process`, {
      ...HTML,
      form: { "refunds[0][method]": "CASH", "refunds[0][amount]": "40.00" },
    });

    const [header] = await db.select().from(salesReturns).where(eq(salesReturns.id, id));
    const [sale] = await db.select().from(sales).where(eq(sales.id, ctx.sale.id));
    const done = await ctx.admin.get(`/returns/${id}`, HTML);

    expect(header.status).toBe("PROCESSED");
    expect(sale.status).toBe("PARTIALLY_REFUNDED");
    expect(await batchQuantity(ctx)).toBe("99994.000");
    expect(done.text).toContain("Cash");
  });

  test("a refusal is flashed back on the return page, not a 500", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.clerk.post(`/returns/${id}/submit`, HTML);
    await ctx.admin.post(`/returns/${id}/approve`, HTML);

    const wrong = await ctx.admin.post(`/returns/${id}/process`, {
      ...HTML,
      form: { refundMethod: "GCASH", referenceNumber: "GC-1" },
    });
    const page = await ctx.admin.get(`/returns/${id}`, HTML);
    const noReason = await ctx.admin.post(`/returns/${id}/cancel`, { ...HTML, form: {} });
    const cancelled = await ctx.admin.post(`/returns/${id}/cancel`, {
      ...HTML,
      form: { reason: "Customer left" },
    });
    const [header] = await db.select().from(salesReturns).where(eq(salesReturns.id, id));

    expect(wrong.status).toBe(302);
    expect(page.text).toContain("was not paid by GCASH");
    expect(noReason.status).toBe(302);
    expect(cancelled.status).toBe(302);
    expect(header.status).toBe("CANCELLED");
    expect(await batchQuantity(ctx)).toBe("99990.000");
  });

  test("the creator cannot approve their own return", async ({ expect }) => {
    const ctx = await setup();
    const saved = await ctx.admin.post(`/sales/${ctx.sale.id}/returns`, {
      ...HTML,
      form: returnForm(ctx),
    });
    const id = saved.location.split("/").pop();

    await ctx.admin.post(`/returns/${id}/submit`, HTML);

    const page = await ctx.admin.get(`/returns/${id}`, HTML);
    const approved = await ctx.admin.post(`/returns/${id}/approve`, HTML);
    const [header] = await db.select().from(salesReturns).where(eq(salesReturns.id, id));

    expect(page.text).not.toContain("/approve");
    expect(page.text).toContain("someone else with approval rights");
    expect(approved.status).toBe(302);
    expect(header.status).toBe("PENDING_APPROVAL");
  });
});
