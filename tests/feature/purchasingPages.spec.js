import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventories } from "../../app/models/inventories.js";
import { purchaseOrders } from "../../app/models/purchase-orders.js";
import { suppliers } from "../../app/models/suppliers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
} from "../../app/services/purchasing/purchaseOrders.js";
import { postReceipt } from "../../app/services/purchasing/receiving.js";
import { createSupplier } from "../../app/services/purchasing/suppliers.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

async function setup() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const person = async (roleName, permissions, branchId = main.id) => {
    return await makeUser({ roleName, permissions, branchId });
  };
  const clerkUser = await person("clerk-pages", ROLE_PERMISSIONS.pharmacist);
  const adminUser = await person("admin-pages", ROLE_PERMISSIONS.admin);
  const clerk = await makeAuthUser({ branchId: main.id, permissions: ROLE_PERMISSIONS.pharmacist });
  const manager = await makeAuthUser({ branchId: main.id, permissions: ROLE_PERMISSIONS.admin });
  const supplier = await createSupplier(clerk, { code: "ACME", name: "Acme Pharma" });
  const stock = await makeProduct({
    branchId: main.id,
    name: "Amoxicillin",
    units: [
      { name: "Capsule", factor: "1", base: true },
      { name: "Box", factor: "100" },
    ],
  });

  return {
    main,
    north,
    clerk,
    manager,
    supplier,
    ...stock,
    clerkSession: await loginAs(clerkUser),
    adminSession: await loginAs(adminUser),
    accountant: await loginAs(await person("accountant-pages", ROLE_PERMISSIONS.accountant)),
    cashier: await loginAs(await person("cashier-pages", ROLE_PERMISSIONS.cashier)),
    stranger: await loginAs(await person("stranger-pages", ROLE_PERMISSIONS.pharmacist, north.id)),
  };
}

const draftIn = async (ctx) => {
  const { id } = await createPurchaseOrder(
    ctx.clerk,
    {
      supplierId: ctx.supplier.id,
      lines: [{ productUnitId: ctx.units[1].id, quantity: "10", unitCost: "250" }],
    },
    { now: new Date("2026-11-12T02:00:00Z") },
  );

  return id;
};

const sentIn = async (ctx) => {
  const id = await draftIn(ctx);

  await submitPurchaseOrder(ctx.clerk, id);
  await approvePurchaseOrder(ctx.manager, id);
  await sendPurchaseOrder(ctx.clerk, id);

  return id;
};

const orderForm = (ctx, overrides = {}) => {
  return {
    supplierId: ctx.supplier.id,
    expectedDate: "2026-12-01",
    notes: "Weekly",
    "lines[0][productUnitId]": ctx.units[1].id,
    "lines[0][quantity]": "10",
    "lines[0][unitCost]": "250",
    ...overrides,
  };
};

test.group("purchasing pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("the pages need purchasing.view, writes need purchasing.manage, receiving needs inventory.receive", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await sentIn(ctx);
    const reads = ["/suppliers", "/purchase-orders", `/purchase-orders/${id}`];
    const writes = ["/suppliers/new", "/purchase-orders/new", `/purchase-orders/${id}/edit`];

    for (const path of reads) {
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.clerkSession.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    for (const path of [...writes, `/purchase-orders/${id}/receive`]) {
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 403]);
    }

    for (const path of ["/suppliers", "/purchase-orders", `/purchase-orders/${id}/approve`]) {
      expect([path, (await ctx.accountant.post(path, { ...HTML, form: {} })).status]).toEqual([
        path,
        403,
      ]);
    }

    // the clerk cannot approve; only the manager role holds purchasing.approve
    expect((await ctx.clerkSession.post(`/purchase-orders/${id}/approve`, HTML)).status).toBe(403);
    expect((await ctx.adminSession.get(`/purchase-orders/${id}/receive`, HTML)).status).toBe(200);
  });

  test("suppliers: a refused form keeps what was typed, a saved one lists, and names are escaped", async ({
    expect,
  }) => {
    const ctx = await setup();
    const refused = await ctx.clerkSession.post("/suppliers", {
      ...HTML,
      form: { code: "", name: XSS, email: "nope" },
    });
    const saved = await ctx.clerkSession.post("/suppliers", {
      ...HTML,
      form: { code: "ZED", name: XSS, paymentTerms: "Net 30" },
    });
    const list = await ctx.clerkSession.get("/suppliers", HTML);
    const [zed] = await db.select().from(suppliers).where(eq(suppliers.code, "ZED"));
    const edit = await ctx.clerkSession.get(`/suppliers/${zed.id}/edit`, HTML);
    const off = await ctx.clerkSession.post(`/suppliers/${zed.id}`, {
      ...HTML,
      form: { code: "ZED", name: "Zed Ltd" },
    });
    const inactive = await ctx.clerkSession.get("/suppliers?active=no", HTML);
    const duplicate = await ctx.clerkSession.post("/suppliers", {
      ...HTML,
      form: { code: "ZED", name: "Again" },
    });

    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Code is required");
    expect(refused.text).toContain("Enter a valid email address");
    expect(refused.text).not.toContain(XSS);
    expect(saved.status).toBe(302);
    expect(list.text).toContain("ZED");
    expect(list.text).not.toContain(XSS);
    expect(edit.status).toBe(200);
    expect(edit.text).toContain("Net 30");
    expect(off.location).toBe("/suppliers");
    expect(inactive.text).toContain("Zed Ltd");
    expect(duplicate.status).toBe(422);
    expect(duplicate.text).toContain("already used");
    expect((await ctx.clerkSession.get("/suppliers/not-an-id/edit", HTML)).status).toBe(404);
  });

  test("the order form lists suppliers and units, refuses bad input in place, and saves a draft", async ({
    expect,
  }) => {
    const ctx = await setup();
    const blank = await ctx.clerkSession.get("/purchase-orders/new", HTML);
    const refused = await ctx.clerkSession.post("/purchase-orders", {
      ...HTML,
      form: orderForm(ctx, { supplierId: "", "lines[0][quantity]": "0", notes: XSS }),
    });
    const noLines = await ctx.clerkSession.post("/purchase-orders", {
      ...HTML,
      form: { supplierId: ctx.supplier.id },
    });
    const saved = await ctx.clerkSession.post("/purchase-orders", {
      ...HTML,
      form: orderForm(ctx),
    });
    const [order] = await db.select().from(purchaseOrders);

    expect(blank.status).toBe(200);
    expect(blank.text).toContain("Acme Pharma");
    expect(blank.text).toContain("Amoxicillin");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Choose a supplier");
    expect(refused.text).toContain("Enter a quantity above 0");
    expect(refused.text).not.toContain(XSS);
    expect(noLines.status).toBe(422);
    expect(noLines.text).toContain("Add 1 to 100 lines");
    expect(saved.location).toBe(`/purchase-orders/${order.id}`);
    expect(order).toMatchObject({ status: "DRAFT", total: "2500.00" });

    const edit = await ctx.clerkSession.get(`/purchase-orders/${order.id}/edit`, HTML);
    const update = await ctx.clerkSession.post(`/purchase-orders/${order.id}`, {
      ...HTML,
      form: orderForm(ctx, { "lines[0][quantity]": "20" }),
    });

    expect(edit.status).toBe(200);
    expect(edit.text).toContain("250.0000");
    expect(update.status).toBe(302);
    expect((await db.select().from(purchaseOrders))[0].total).toBe("5000.00");
  });

  test("an order walks from draft to received through its pages", async ({ expect }) => {
    const ctx = await setup();
    const id = await draftIn(ctx);
    const page = `/purchase-orders/${id}`;
    const status = async () => {
      return (await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)))[0].status;
    };

    const draft = await ctx.clerkSession.get(page, HTML);

    expect(draft.text).toContain("Submit for approval");
    expect(draft.text).not.toContain("Receive goods");

    await ctx.clerkSession.post(`${page}/submit`, HTML);

    expect(await status()).toBe("PENDING_APPROVAL");
    expect((await ctx.clerkSession.get(page, HTML)).text).not.toContain(">Approve<");
    expect((await ctx.adminSession.get(page, HTML)).text).toContain(">Approve<");

    await ctx.adminSession.post(`${page}/approve`, HTML);
    await ctx.clerkSession.post(`${page}/send`, HTML);

    expect(await status()).toBe("SENT");

    const form = await ctx.clerkSession.get(`${page}/receive`, HTML);
    const over = await ctx.clerkSession.post(`${page}/receive`, {
      ...HTML,
      form: receiptForm(form.text, { accepted: "11", batch: "LOT-1", expiry: "2028-01-31" }),
    });
    const posted = await ctx.clerkSession.post(`${page}/receive`, {
      ...HTML,
      form: receiptForm(form.text, {
        accepted: "9",
        rejected: "1",
        reason: "crushed",
        batch: "LOT-1",
        expiry: "2028-01-31",
      }),
    });
    const duplicate = await ctx.clerkSession.post(`${page}/receive`, {
      ...HTML,
      form: receiptForm(form.text, { accepted: "1", batch: "LOT-1", expiry: "2028-01-31" }),
    });
    const again = await ctx.clerkSession.post(`${page}/receive`, {
      ...HTML,
      form: receiptForm(form.text, {
        accepted: "1",
        batch: "LOT-2",
        expiry: "2028-01-31",
        invoice: "INV-10",
      }),
    });
    const after = await ctx.clerkSession.get(page, HTML);
    const [row] = await db
      .select()
      .from(inventories)
      .where(eq(inventories.productId, ctx.product.id));

    expect(form.status).toBe(200);
    expect(form.text).toContain("Receive goods");
    expect(over.status).toBe(422);
    expect(over.text).toContain("More than is still open on the order (10.000)");
    expect(over.text).toContain("LOT-1");
    expect(posted.status).toBe(302);
    expect(duplicate.status).toBe(302);
    expect(again.status).toBe(302);
    expect(row.quantityOnHand).toBe("1000.000");
    expect(await status()).toBe("FULLY_RECEIVED");
    expect(after.text).toContain("GR-MAIN-");
    expect(after.text).toContain("INV-9");
    expect(after.text).toContain("INV-10");
    expect(after.text).toContain("Close order");
  });

  test("another branch gets 404, and every status renders", async ({ expect }) => {
    const ctx = await setup();
    const draft = await draftIn(ctx);
    const pending = await draftIn(ctx);
    const cancelled = await draftIn(ctx);
    const sent = await sentIn(ctx);
    const partly = await sentIn(ctx);

    await submitPurchaseOrder(ctx.clerk, pending);
    await cancelPurchaseOrder(ctx.clerk, cancelled, { reason: "not needed" });

    const { lines } = await getPurchaseOrder(ctx.manager, partly);

    await postReceipt(
      ctx.clerk,
      partly,
      {
        supplierInvoiceNumber: "INV-P",
        lines: [
          {
            purchaseOrderItemId: lines[0].id,
            batchNumber: "P1",
            expirationDate: "2028-01-31",
            quantityAccepted: "4",
          },
        ],
      },
      { now: new Date("2026-11-12T02:00:00Z") },
    );

    for (const id of [draft, pending, cancelled, sent, partly]) {
      expect([id, (await ctx.adminSession.get(`/purchase-orders/${id}`, HTML)).status]).toEqual([
        id,
        200,
      ]);
      expect((await ctx.stranger.get(`/purchase-orders/${id}`, HTML)).status).toBe(404);
    }

    const all = await ctx.clerkSession.get("/purchase-orders", HTML);
    const filtered = await ctx.clerkSession.get("/purchase-orders?status=CANCELLED", HTML);
    const odd = await ctx.clerkSession.get("/purchase-orders?status=nope&page=-3", HTML);
    const strangerList = await ctx.stranger.get("/purchase-orders", HTML);

    expect(all.text).toContain("PO-MAIN-20261112-0001");
    expect(filtered.text).toContain("Cancelled");
    expect(filtered.text).not.toContain("PO-MAIN-20261112-0001");
    expect(odd.status).toBe(200);
    expect(strangerList.text).toContain("No purchase orders");
    expect((await ctx.stranger.post(`/purchase-orders/${draft}/submit`, HTML)).status).toBe(404);
    expect((await ctx.clerkSession.get("/purchase-orders/not-an-id", HTML)).status).toBe(404);
  });
});

// Builds the posted form of the receiving page for its first row only (the page's own hidden item id).
function receiptForm(
  html,
  { accepted, rejected = "", reason = "", batch, expiry, invoice = "INV-9" },
) {
  const item = /name="lines\[0\]\[purchaseOrderItemId\]" value="([^"]+)"/.exec(html)[1];

  return {
    supplierInvoiceNumber: invoice,
    "lines[0][purchaseOrderItemId]": item,
    "lines[0][batchNumber]": batch,
    "lines[0][expirationDate]": expiry,
    "lines[0][quantityAccepted]": accepted,
    "lines[0][quantityRejected]": rejected,
    "lines[0][rejectionReason]": reason,
  };
}
