import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { stockTransferItems } from "../../app/models/stock-transfer-items.js";
import { stockTransfers } from "../../app/models/stock-transfers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeProduct, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };

// MAIN holds 500 tablets (LOT-A); NORTH requests from it.
async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const east = await makeBranch({ code: "EAST" });
  const person = async (roleName, permissions, branchId) => {
    return await loginAs(await makeUser({ roleName, permissions, branchId }));
  };
  const stock = await makeProduct({
    branchId: main.id,
    units: [{ name: "Tablet", factor: "1", base: true }],
    batches: [{ quantity: "500", batchNumber: "LOT-A" }],
  });

  return {
    main,
    north,
    batch: stock.batches[0],
    product: stock.product,
    requester: await person("req-transfers", ROLE_PERMISSIONS.pharmacist, north.id),
    northAdmin: await person("north-admin-transfers", ROLE_PERMISSIONS.admin, north.id),
    shipper: await person("ship-transfers", ROLE_PERMISSIONS.pharmacist, main.id),
    approver: await person("approve-transfers", ROLE_PERMISSIONS.admin, main.id),
    accountant: await person("acct-transfers", ROLE_PERMISSIONS.accountant, north.id),
    cashier: await person("cash-transfers", ROLE_PERMISSIONS.cashier, north.id),
    stranger: await person("east-transfers", ROLE_PERMISSIONS.pharmacist, east.id),
  };
}

const requestForm = (ctx, overrides = {}) => {
  return {
    sourceBranchId: ctx.main.id,
    "lines[0][sourceBatchId]": ctx.batch.id,
    "lines[0][quantity]": "100",
    "lines[1][sourceBatchId]": "",
    "lines[1][quantity]": "",
    ...overrides,
  };
};

const draftIn = async (ctx) => {
  const saved = await ctx.requester.post("/transfers", { ...HTML, form: requestForm(ctx) });

  return saved.location.split("/").pop();
};

const itemOf = async (id) => {
  const [row] = await db
    .select()
    .from(stockTransferItems)
    .where(eq(stockTransferItems.stockTransferId, id));

  return row;
};

const statusOf = async (id) => {
  const [row] = await db.select().from(stockTransfers).where(eq(stockTransfers.id, id));

  return row.status;
};

test.group("transfer pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("viewing needs a transfer permission, other branches see nothing", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    for (const path of ["/transfers", `/transfers/${id}`]) {
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.requester.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.shipper.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    expect((await ctx.stranger.get(`/transfers/${id}`, HTML)).status).toBe(404);
    expect((await ctx.requester.get("/transfers/not-an-id", HTML)).status).toBe(404);
    expect((await ctx.accountant.get("/transfers/new", HTML)).status).toBe(403);
    expect((await ctx.cashier.post("/transfers", { ...HTML, form: {} })).status).toBe(403);
    expect((await ctx.requester.post(`/transfers/${id}/approve`, HTML)).status).toBe(403);
  });

  test("the request form lists the branches, then that branch's stock; a refused one keeps the typing", async ({
    expect,
  }) => {
    const ctx = await setup();
    const first = await ctx.requester.get("/transfers/new", HTML);
    const second = await ctx.requester.get(`/transfers/new?source=${ctx.main.id}`, HTML);
    const refused = await ctx.requester.post("/transfers", {
      ...HTML,
      form: requestForm(ctx, { "lines[0][quantity]": "9999" }),
    });
    const id = await draftIn(ctx);
    const list = await ctx.requester.get("/transfers?status=DRAFT", HTML);
    const page = await ctx.requester.get(`/transfers/${id}`, HTML);

    expect(first.text).toContain("Choose a branch");
    expect(first.text).not.toContain("LOT-A");
    expect(second.text).toContain("LOT-A");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Only 500.000 available");
    expect(refused.text).toContain('value="9999"');
    expect(list.text).toContain("TRF-");
    expect(page.text).toContain("Submit for approval");
    expect((await ctx.requester.get("/transfers?page=99999999999999999999", HTML)).status).toBe(
      200,
    );
  });

  test("the whole flow: request, approve, dispatch, receive", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.requester.post(`/transfers/${id}/submit`, HTML);

    const pending = await ctx.approver.get(`/transfers/${id}`, HTML);

    await ctx.approver.post(`/transfers/${id}/approve`, HTML);

    const item = await itemOf(id);
    const toShip = await ctx.shipper.get(`/transfers/${id}`, HTML);

    expect(pending.text).toContain("Approve");
    expect(toShip.text).toContain(`name="lines[0][quantity]" value="100.000"`);

    await ctx.shipper.post(`/transfers/${id}/dispatch`, {
      ...HTML,
      form: { "lines[0][itemId]": item.id, "lines[0][quantity]": "80" },
    });

    expect(await statusOf(id)).toBe("IN_TRANSIT");

    const [source] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, ctx.batch.id));

    expect(source.quantityAvailable).toBe("420.000");

    const arriving = await ctx.requester.get(`/transfers/${id}`, HTML);

    expect(arriving.text).toContain("Record what arrived");
    expect(arriving.text).toContain(`value="80.000"`);

    await ctx.requester.post(`/transfers/${id}/receive`, {
      ...HTML,
      form: { "lines[0][itemId]": item.id, "lines[0][quantity]": "80" },
    });

    const [copy] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.branchId, ctx.north.id));

    expect(await statusOf(id)).toBe("RECEIVED");
    expect(copy.quantityAvailable).toBe("80.000");
    expect((await ctx.requester.get(`/transfers/${id}`, HTML)).text).not.toContain(
      "Record what arrived",
    );
  });

  test("refusals are flashed back on the transfer page, not a 500", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);

    await ctx.requester.post(`/transfers/${id}/submit`, HTML);

    // the destination's own admin is on the wrong side of an approval
    const wrongSide = await ctx.northAdmin.post(`/transfers/${id}/approve`, HTML);
    const flashed = await ctx.northAdmin.get(`/transfers/${id}`, HTML);

    expect(wrongSide.status).toBe(302);
    expect(flashed.text).toContain("Only the source branch can do this");

    await ctx.approver.post(`/transfers/${id}/approve`, HTML);

    const item = await itemOf(id);
    const nothing = await ctx.shipper.post(`/transfers/${id}/dispatch`, {
      ...HTML,
      form: { "lines[0][itemId]": item.id, "lines[0][quantity]": "0" },
    });
    const page = await ctx.shipper.get(`/transfers/${id}`, HTML);
    const noReason = await ctx.requester.post(`/transfers/${id}/cancel`, { ...HTML, form: {} });

    expect(nothing.status).toBe(302);
    expect(page.text).toContain("Ship at least one line");
    expect(noReason.status).toBe(302);
    expect(await statusOf(id)).toBe("APPROVED");

    await ctx.requester.post(`/transfers/${id}/cancel`, {
      ...HTML,
      form: { reason: "Not needed" },
    });

    expect(await statusOf(id)).toBe("CANCELLED");
  });
});
