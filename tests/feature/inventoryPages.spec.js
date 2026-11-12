import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { loginAs, TestSession } from "../helpers/http.js";
import { makeBranch, makeProduct, makeUser } from "../helpers/factories.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

const day = (offset) => {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
};

async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const as = async (roleName, permissions, branchId = main.id) => {
    return await loginAs(await makeUser({ roleName, permissions, branchId }));
  };
  const alpha = await makeProduct({
    branchId: main.id,
    name: "Alpha",
    sku: "A-1",
    reorderLevel: "500",
    batches: [
      { quantity: "60", batchNumber: "A-OK", expirationDate: day(300) },
      { quantity: "50", batchNumber: "A-SOON", expirationDate: day(10) },
      { quantity: "40", batchNumber: "A-QUAR", expirationDate: day(300), status: "QUARANTINED" },
      { quantity: "30", batchNumber: "A-RECALL", expirationDate: day(300), status: "RECALLED" },
    ],
  });
  await makeProduct({
    branchId: north.id,
    name: "Northern",
    sku: "N-1",
    batches: [{ quantity: "7", batchNumber: "N-OK", expirationDate: day(300) }],
  });

  return {
    main,
    north,
    alpha,
    pharmacist: await as("pharmacist-pages", ROLE_PERMISSIONS.pharmacist),
    accountant: await as("accountant-pages", ROLE_PERMISSIONS.accountant),
    cashier: await as("cashier-pages", ROLE_PERMISSIONS.cashier),
    admin: await as("admin-pages", ROLE_PERMISSIONS.admin),
    batch: (number) => {
      return alpha.batches.find((batch) => {
        return batch.batchNumber === number;
      });
    },
  };
}

const status = async (id) => {
  const [row] = await db.select().from(inventoryBatches).where(eq(inventoryBatches.id, id));

  return row.status;
};

test.group("inventory pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("the pages need inventory.view, the actions need inventory.manage", async ({ expect }) => {
    const ctx = await setup();
    const id = ctx.batch("A-OK").id;
    const reads = ["/inventory", "/inventory/batches"];
    const writes = ["quarantine", "release", "recall", "write-off"].map((action) => {
      return `/inventory/batches/${id}/${action}`;
    });

    for (const path of reads) {
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.pharmacist.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    for (const path of writes) {
      const form = { reason: "x", kind: "damaged" };

      expect([path, (await ctx.cashier.post(path, { ...HTML, form })).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.post(path, { ...HTML, form })).status]).toEqual([
        path,
        403,
      ]);
      expect((await new TestSession().post(path, { ...HTML, form })).location).toBe("/login-page");
    }

    expect(await status(id)).toBe("ACTIVE");
  });

  test("the overview shows on hand, sellable and the alerts, and its filters work", async ({
    expect,
  }) => {
    const ctx = await setup();

    const all = await ctx.pharmacist.get("/inventory", HTML);
    const low = await ctx.pharmacist.get("/inventory?flag=low", HTML);
    const expiring = await ctx.pharmacist.get("/inventory?flag=expiring", HTML);
    const none = await ctx.pharmacist.get("/inventory?q=zzz", HTML);
    const percent = await ctx.pharmacist.get("/inventory?q=%25", HTML);

    expect(all.text).toContain("Alpha");
    expect(all.text).not.toContain("Northern");
    expect(all.text).toContain("180"); // on hand 60 + 50 + 40 + 30
    expect(all.text).toContain("110"); // sellable 60 + 50
    expect(all.text).toContain("Low stock");
    expect(all.text).toContain("Expiring soon");
    expect(low.text).toContain("Alpha");
    expect(expiring.text).toContain("Alpha");
    expect(none.text).toContain("No stock found");
    expect(percent.text).toContain("No stock found");
  });

  test("the batch list filters, and shows the actions a status allows", async ({ expect }) => {
    const ctx = await setup();

    const all = await ctx.pharmacist.get("/inventory/batches", HTML);
    const quarantined = await ctx.pharmacist.get("/inventory/batches?status=QUARANTINED", HTML);
    const soon = await ctx.pharmacist.get("/inventory/batches?expiry=30", HTML);
    const search = await ctx.pharmacist.get("/inventory/batches?q=A-RECALL", HTML);
    const readOnly = await ctx.accountant.get("/inventory/batches", HTML);

    for (const number of ["A-OK", "A-SOON", "A-QUAR", "A-RECALL"]) {
      expect(all.text).toContain(number);
    }

    expect(all.text).not.toContain("N-OK");
    expect(quarantined.text).toContain("A-QUAR");
    expect(quarantined.text).not.toContain("A-OK");
    expect(quarantined.text).toContain("/release");
    expect(quarantined.text).not.toContain(
      `/inventory/batches/${ctx.batch("A-QUAR").id}/quarantine`,
    );
    expect(soon.text).toContain("A-SOON");
    expect(soon.text).not.toContain("A-OK");
    expect(search.text).toContain("A-RECALL");
    expect(search.text).not.toContain("/release");
    expect(search.text).not.toContain("/write-off");
    expect(all.text).toContain(`/inventory/batches/${ctx.batch("A-OK").id}/write-off`);
    expect(readOnly.text).toContain("A-OK");
    expect(readOnly.text).not.toContain("/quarantine");
  });

  test("an action flashes its result, changes the batch, audits it and goes back to the filtered list", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = ctx.batch("A-OK").id;

    const done = await ctx.pharmacist.post(`/inventory/batches/${id}/quarantine`, {
      ...HTML,
      form: { reason: "Suspect seal", back: "/inventory/batches?status=ACTIVE" },
    });
    const list = await ctx.pharmacist.get(done.location, HTML);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));

    expect([done.status, done.location]).toEqual([302, "/inventory/batches?status=ACTIVE"]);
    expect(await status(id)).toBe("QUARANTINED");
    expect(list.text).toContain('<meta name="flash-success" content="Batch quarantined">');
    expect(audit).toMatchObject({ action: "BATCH_QUARANTINED", reason: "Suspect seal" });

    const written = await ctx.pharmacist.post(`/inventory/batches/${id}/write-off`, {
      ...HTML,
      form: { reason: "Destroyed", kind: "damaged" },
    });

    expect([written.status, written.location]).toEqual([302, "/inventory/batches"]);
    expect(await status(id)).toBe("DEPLETED");
  });

  test("a refused action flashes the reason and changes nothing", async ({ expect }) => {
    const ctx = await setup();
    const recalled = ctx.batch("A-RECALL").id;
    const active = ctx.batch("A-OK").id;

    const state = await ctx.pharmacist.post(`/inventory/batches/${recalled}/release`, {
      ...HTML,
      form: { reason: "oops" },
    });
    const stateList = await ctx.pharmacist.get(state.location, HTML);
    const blank = await ctx.pharmacist.post(`/inventory/batches/${active}/quarantine`, {
      ...HTML,
      form: { reason: "   " },
    });
    const blankList = await ctx.pharmacist.get(blank.location, HTML);
    const noKind = await ctx.pharmacist.post(`/inventory/batches/${active}/write-off`, {
      ...HTML,
      form: { reason: "ok" },
    });

    expect(state.status).toBe(302);
    expect(stateList.text).toContain('<meta name="flash-error" content="A recalled batch');
    expect(blank.status).toBe(302);
    expect(blankList.text).toContain('<meta name="flash-error" content="Give a reason');
    expect(noKind.status).toBe(302);
    expect(await status(recalled)).toBe("RECALLED");
    expect(await status(active)).toBe("ACTIVE");
  });

  test("a back address that leaves the batch list is ignored", async ({ expect }) => {
    const ctx = await setup();
    const id = ctx.batch("A-OK").id;

    for (const back of ["//evil.test/x", "https://evil.test", "/products", "/inventory/batchesX"]) {
      const response = await ctx.pharmacist.post(`/inventory/batches/${id}/quarantine`, {
        ...HTML,
        form: { reason: "x", back },
      });

      expect([back, response.location]).toEqual([back, "/inventory/batches"]);
      await db
        .update(inventoryBatches)
        .set({ status: "ACTIVE" })
        .where(eq(inventoryBatches.id, id));
    }
  });

  test("a branch is limited to its own staff, except for the all-branch scope (review focus 3)", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { north } = ctx;
    const [northBatch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.batchNumber, "N-OK"));

    const own = await ctx.pharmacist.get(`/inventory?branchId=${ctx.main.id}`, HTML);
    const foreign = await ctx.pharmacist.get(`/inventory?branchId=${north.id}`, HTML);
    const foreignBatches = await ctx.pharmacist.get(
      `/inventory/batches?branchId=${north.id}`,
      HTML,
    );
    const crafted = await ctx.pharmacist.get("/inventory?branchId=not-a-uuid", HTML);
    const accountantNorth = await ctx.accountant.get(`/inventory?branchId=${north.id}`, HTML);
    const adminBatches = await ctx.admin.get(`/inventory/batches?branchId=${north.id}`, HTML);
    const refused = await ctx.pharmacist.post(`/inventory/batches/${northBatch.id}/quarantine`, {
      ...HTML,
      form: { reason: "x" },
    });

    expect(own.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(foreignBatches.status).toBe(403);
    expect(crafted.status).toBe(200);
    expect(crafted.text).toContain("Some filters were not applied");
    expect(crafted.text).not.toContain("Northern");
    expect(accountantNorth.status).toBe(200);
    expect(accountantNorth.text).toContain("Northern");
    expect(accountantNorth.text).toContain("NORTH");
    expect(adminBatches.text).toContain("N-OK");
    expect(refused.status).toBe(404);
    expect(await status(northBatch.id)).toBe("ACTIVE");
  });

  test("bad filters show a notice instead of failing, and crafted ids are a 404", async ({
    expect,
  }) => {
    const ctx = await setup();

    const badFlag = await ctx.pharmacist.get("/inventory?flag=nope", HTML);
    const badStatus = await ctx.pharmacist.get("/inventory/batches?status=nope&page=0", HTML);
    const longText = await ctx.pharmacist.get(`/inventory?q=${"x".repeat(200)}`, HTML);

    for (const page of [badFlag, badStatus, longText]) {
      expect(page.status).toBe(200);
      expect(page.text).toContain("Some filters were not applied");
    }

    for (const id of [randomUUID(), "not-a-uuid", "%C3%A9"]) {
      const response = await ctx.pharmacist.post(`/inventory/batches/${id}/quarantine`, {
        ...HTML,
        form: { reason: "x" },
      });

      expect([id, response.status]).toEqual([id, 404]);
    }
  });

  test("names and reasons are escaped (review focus 5)", async ({ expect }) => {
    const ctx = await setup();
    const stocked = await makeProduct({
      branchId: ctx.main.id,
      name: XSS,
      sku: "X-1",
      batches: [{ quantity: "5", batchNumber: XSS, expirationDate: day(200) }],
    });
    const id = stocked.batches[0].id;

    await ctx.pharmacist.post(`/inventory/batches/${id}/recall`, {
      ...HTML,
      form: { reason: XSS },
    });
    const overview = await ctx.pharmacist.get("/inventory?q=X-1", HTML);
    const list = await ctx.pharmacist.get("/inventory/batches?q=X-1", HTML);
    const searched = await ctx.pharmacist.get(`/inventory?q=${encodeURIComponent(XSS)}`, HTML);

    for (const page of [overview, list, searched]) {
      expect(page.text).not.toContain("<img src=x");
    }

    expect(overview.text).toContain("&lt;img");
    expect(list.text).toContain("&lt;img");
  });
});
