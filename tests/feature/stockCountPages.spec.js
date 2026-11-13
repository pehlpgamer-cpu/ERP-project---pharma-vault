import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventoryAdjustments } from "../../app/models/inventory-adjustments.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeProduct, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const person = async (roleName, permissions, branchId = main.id) => {
    return await makeUser({ roleName, permissions, branchId });
  };
  const stock = await makeProduct({
    branchId: main.id,
    name: "Amoxicillin",
    units: [{ name: "Capsule", factor: "1", base: true }],
    batches: [{ quantity: "500", batchNumber: "LOT-A" }],
  });

  return {
    ...stock,
    batch: stock.batches[0],
    clerk: await loginAs(await person("clerk-counts", ROLE_PERMISSIONS.pharmacist)),
    admin: await loginAs(await person("admin-counts", ROLE_PERMISSIONS.admin)),
    accountant: await loginAs(await person("accountant-counts", ROLE_PERMISSIONS.accountant)),
    cashier: await loginAs(await person("cashier-counts", ROLE_PERMISSIONS.cashier)),
    stranger: await loginAs(await person("stranger-counts", ROLE_PERMISSIONS.pharmacist, north.id)),
  };
}

const countForm = (ctx, overrides = {}) => {
  return {
    reason: "Quarterly count",
    "lines[0][inventoryBatchId]": ctx.batch.id,
    "lines[0][countedQuantity]": "485",
    "lines[1][inventoryBatchId]": "",
    "lines[1][countedQuantity]": "",
    ...overrides,
  };
};

const draftIn = async (ctx) => {
  const saved = await ctx.clerk.post("/stock-counts", { ...HTML, form: countForm(ctx) });

  return saved.location.split("/").pop();
};

test.group("stock count pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("viewing needs inventory.view, drafting needs inventory.adjust, approving needs inventory.approve", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    for (const path of ["/stock-counts", `/stock-counts/${id}`]) {
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.clerk.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    expect((await ctx.accountant.get("/stock-counts/new", HTML)).status).toBe(403);
    expect((await ctx.accountant.post("/stock-counts", { ...HTML, form: {} })).status).toBe(403);
    expect((await ctx.clerk.post(`/stock-counts/${id}/approve`, HTML)).status).toBe(403);
    expect((await ctx.clerk.post(`/stock-counts/${id}/post`, HTML)).status).toBe(403);
    expect((await ctx.stranger.get(`/stock-counts/${id}`, HTML)).status).toBe(404);
    expect((await ctx.clerk.get("/stock-counts/not-an-id", HTML)).status).toBe(404);
  });

  test("a refused form keeps what was typed and escapes it; a saved one is listed", async ({
    expect,
  }) => {
    const ctx = await setup();
    const blank = await ctx.clerk.get("/stock-counts/new", HTML);
    const refused = await ctx.clerk.post("/stock-counts", {
      ...HTML,
      form: countForm(ctx, { reason: XSS, "lines[0][countedQuantity]": "501" }),
    });
    const id = await draftIn(ctx);
    const list = await ctx.clerk.get("/stock-counts?status=DRAFT", HTML);
    const page = await ctx.clerk.get(`/stock-counts/${id}`, HTML);

    expect(blank.status).toBe(200);
    expect(blank.text).toContain("LOT-A");
    // every signed-in page locks a form after its first submit, so a double click saves once
    expect(blank.text).toContain("dataset.submitting");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Cannot exceed");
    expect(refused.text).not.toContain(XSS);
    expect(refused.text).toContain('value="501"');
    expect(list.text).toContain("ADJ-");
    expect(page.text).toContain("Quarterly count");
    expect(page.text).toContain("-15");
    expect(page.text).toContain("Submit for approval");
    expect((await ctx.clerk.get("/stock-counts?page=99999999999999999999", HTML)).status).toBe(200);
  });

  test("the whole flow: submit, a different person approves, post sets the batch", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);
    const submitted = await ctx.clerk.post(`/stock-counts/${id}/submit`, HTML);
    const pending = await ctx.admin.get(`/stock-counts/${id}`, HTML);
    const approved = await ctx.admin.post(`/stock-counts/${id}/approve`, HTML);
    const ready = await ctx.admin.get(`/stock-counts/${id}`, HTML);

    expect(submitted.location).toBe(`/stock-counts/${id}`);
    expect(pending.text).toContain("Approve");
    expect(approved.location).toBe(`/stock-counts/${id}`);
    expect(ready.text).toContain("Post count");

    await ctx.admin.post(`/stock-counts/${id}/post`, HTML);

    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, ctx.batch.id));
    const [row] = await db
      .select()
      .from(inventoryAdjustments)
      .where(eq(inventoryAdjustments.id, id));

    expect(batch.quantityAvailable).toBe("485.000");
    expect(row.status).toBe("POSTED");
  });

  test("a refusal is flashed back on the count page, not a 500", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.clerk.post(`/stock-counts/${id}/submit`, HTML);

    // moved stock, then post: stale
    await ctx.admin.post(`/stock-counts/${id}/approve`, HTML);
    await db
      .update(inventoryBatches)
      .set({ quantityAvailable: "490.000" })
      .where(eq(inventoryBatches.id, ctx.batch.id));

    const posted = await ctx.admin.post(`/stock-counts/${id}/post`, HTML);
    const page = await ctx.admin.get(`/stock-counts/${id}`, HTML);
    const noReason = await ctx.clerk.post(`/stock-counts/${id}/cancel`, { ...HTML, form: {} });
    const cancelled = await ctx.clerk.post(`/stock-counts/${id}/cancel`, {
      ...HTML,
      form: { reason: "Counted again" },
    });

    expect(posted.status).toBe(302);
    expect(page.text).toContain("changed since it was counted");
    expect(noReason.status).toBe(302);
    expect(cancelled.status).toBe(302);

    const [row] = await db
      .select()
      .from(inventoryAdjustments)
      .where(eq(inventoryAdjustments.id, id));

    expect(row.status).toBe("CANCELLED");
  });

  test("the creator cannot approve their own count", async ({ expect }) => {
    const ctx = await setup();
    const saved = await ctx.admin.post("/stock-counts", { ...HTML, form: countForm(ctx) });
    const id = saved.location.split("/").pop();

    await ctx.admin.post(`/stock-counts/${id}/submit`, HTML);

    const page = await ctx.admin.get(`/stock-counts/${id}`, HTML);
    const approved = await ctx.admin.post(`/stock-counts/${id}/approve`, HTML);
    const [row] = await db
      .select()
      .from(inventoryAdjustments)
      .where(eq(inventoryAdjustments.id, id));

    expect(page.text).not.toContain("/approve");
    expect(page.text).toContain("someone else with approval rights");
    expect(approved.status).toBe(302);
    expect(row.status).toBe("PENDING_APPROVAL");
  });
});
