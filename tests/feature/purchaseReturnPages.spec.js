import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { purchaseReturns } from "../../app/models/purchase-returns.js";
import { suppliers } from "../../app/models/suppliers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeProduct, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };

async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const person = async (roleName, permissions, branchId = main.id) => {
    return await loginAs(await makeUser({ roleName, permissions, branchId }));
  };
  const supplier = { id: randomUUID(), code: "SUP-9", name: "Acme Pharma Supply" };

  await db.insert(suppliers).values(supplier);

  const stock = await makeProduct({
    branchId: main.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "500", batchNumber: "LOT-A", unitCost: "2.0000" }],
  });

  return {
    supplier,
    batch: stock.batches[0],
    clerk: await person("clerk-prt", ROLE_PERMISSIONS.pharmacist),
    admin: await person("admin-prt", ROLE_PERMISSIONS.admin),
    accountant: await person("acct-prt", ROLE_PERMISSIONS.accountant),
    cashier: await person("cash-prt", ROLE_PERMISSIONS.cashier),
    stranger: await person("north-prt", ROLE_PERMISSIONS.pharmacist, north.id),
  };
}

const returnForm = (ctx, overrides = {}) => {
  return {
    supplierId: ctx.supplier.id,
    reason: "Damaged in transit",
    "lines[0][inventoryBatchId]": ctx.batch.id,
    "lines[0][quantity]": "50",
    "lines[1][inventoryBatchId]": "",
    "lines[1][quantity]": "",
    ...overrides,
  };
};

const draftIn = async (ctx) => {
  const saved = await ctx.clerk.post("/purchase-returns", { ...HTML, form: returnForm(ctx) });

  return saved.location.split("/").pop();
};

const statusOf = async (id) => {
  const [row] = await db.select().from(purchaseReturns).where(eq(purchaseReturns.id, id));

  return row.status;
};

test.group("supplier return pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("viewing needs purchasing.view, drafting purchasing.manage, approving purchasing.approve", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    for (const path of ["/purchase-returns", `/purchase-returns/${id}`]) {
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.clerk.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    expect((await ctx.accountant.get("/purchase-returns/new", HTML)).status).toBe(403);
    expect((await ctx.accountant.post("/purchase-returns", { ...HTML, form: {} })).status).toBe(
      403,
    );
    expect((await ctx.clerk.post(`/purchase-returns/${id}/approve`, HTML)).status).toBe(403);
    expect((await ctx.clerk.post(`/purchase-returns/${id}/post`, HTML)).status).toBe(403);
    expect((await ctx.stranger.get(`/purchase-returns/${id}`, HTML)).status).toBe(404);
    expect((await ctx.clerk.get("/purchase-returns/not-an-id", HTML)).status).toBe(404);
  });

  test("a refused form keeps what was typed; a saved one is listed with its value", async ({
    expect,
  }) => {
    const ctx = await setup();
    const blank = await ctx.clerk.get("/purchase-returns/new", HTML);
    const refused = await ctx.clerk.post("/purchase-returns", {
      ...HTML,
      form: returnForm(ctx, { "lines[0][quantity]": "501" }),
    });
    const id = await draftIn(ctx);
    const list = await ctx.clerk.get("/purchase-returns?status=DRAFT", HTML);
    const page = await ctx.clerk.get(`/purchase-returns/${id}`, HTML);

    expect(blank.text).toContain("Acme Pharma Supply");
    expect(blank.text).toContain("LOT-A");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Only 500.000 is in this batch");
    expect(refused.text).toContain('value="501"');
    expect(list.text).toContain("PRT-");
    expect(page.text).toContain("100.00");
    expect(page.text).toContain("2.0000");
    expect(page.text).toContain("Submit for approval");
    expect((await ctx.clerk.get("/purchase-returns?page=99999999999999999999", HTML)).status).toBe(
      200,
    );
  });

  test("the whole flow: submit, a different person approves, post takes the stock off", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.clerk.post(`/purchase-returns/${id}/submit`, HTML);

    const pending = await ctx.admin.get(`/purchase-returns/${id}`, HTML);

    await ctx.admin.post(`/purchase-returns/${id}/approve`, HTML);

    const ready = await ctx.admin.get(`/purchase-returns/${id}`, HTML);

    expect(pending.text).toContain("Approve");
    expect(ready.text).toContain("Post return");

    await ctx.admin.post(`/purchase-returns/${id}/post`, HTML);

    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, ctx.batch.id));

    expect(await statusOf(id)).toBe("POSTED");
    expect(batch.quantityAvailable).toBe("450.000");
  });

  test("a refusal is flashed back on the return page, not a 500", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.clerk.post(`/purchase-returns/${id}/submit`, HTML);
    await ctx.admin.post(`/purchase-returns/${id}/approve`, HTML);
    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "10.000" })
      .where(eq(inventoryBatches.id, ctx.batch.id));

    const posted = await ctx.admin.post(`/purchase-returns/${id}/post`, HTML);
    const page = await ctx.admin.get(`/purchase-returns/${id}`, HTML);
    const noReason = await ctx.clerk.post(`/purchase-returns/${id}/cancel`, { ...HTML, form: {} });

    expect(posted.status).toBe(302);
    expect(page.text).toContain("no longer holds");
    expect(noReason.status).toBe(302);
    expect(await statusOf(id)).toBe("APPROVED");

    await ctx.clerk.post(`/purchase-returns/${id}/cancel`, {
      ...HTML,
      form: { reason: "Recount" },
    });

    expect(await statusOf(id)).toBe("CANCELLED");
  });

  test("the creator cannot approve their own return", async ({ expect }) => {
    const ctx = await setup();
    const saved = await ctx.admin.post("/purchase-returns", { ...HTML, form: returnForm(ctx) });
    const id = saved.location.split("/").pop();

    await ctx.admin.post(`/purchase-returns/${id}/submit`, HTML);

    const page = await ctx.admin.get(`/purchase-returns/${id}`, HTML);
    const approved = await ctx.admin.post(`/purchase-returns/${id}/approve`, HTML);

    expect(page.text).not.toContain("/approve");
    expect(page.text).toContain("someone else with approval rights");
    expect(approved.status).toBe(302);
    expect(await statusOf(id)).toBe("PENDING_APPROVAL");
  });
});
