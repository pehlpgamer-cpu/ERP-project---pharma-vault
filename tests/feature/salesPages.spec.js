import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeCustomer,
  makeProduct,
  makeSaleIn,
  makeUser,
  makeWorld,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

test.group("sales list page", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("lists the cashier's own sales with links, badges and the echoed search", async ({
    expect,
  }) => {
    const world = await makeWorld();
    const first = await makeSaleIn(world, { invoiceNumber: "INV-A" });
    await makeSaleIn(world, { invoiceNumber: "INV-B" });
    const other = await makeUser({ branchId: world.branch.id });
    await makeSaleIn(world, { invoiceNumber: "INV-OTHER", cashierId: other.id });
    const session = await loginAs(world.cashier);

    const all = await session.get("/sales", HTML);
    const searched = await session.get("/sales?q=INV-A", HTML);
    const empty = await session.get("/sales?q=zzz", HTML);

    expect(all.status).toBe(200);
    expect(all.text).toContain("INV-A");
    expect(all.text).toContain("INV-B");
    expect(all.text).not.toContain("INV-OTHER");
    expect(all.text).toContain(`href="/sales/${first.id}"`);
    expect(all.text).toContain("Completed");
    expect(searched.text).toContain('value="INV-A"');
    expect(searched.text).not.toContain("INV-B");
    expect(empty.text).toContain("No sales found");
  });

  test("an invalid filter shows a message and falls back to the default list", async ({
    expect,
  }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { invoiceNumber: "INV-A" });
    const session = await loginAs(world.cashier);

    const response = await session.get("/sales?from=2026-12-01&to=2026-11-01", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("from must not be after to");
    expect(response.text).toContain("INV-A");
  });

  test("branch and cashier selectors appear only where the scope allows them", async ({
    expect,
  }) => {
    const world = await makeWorld({ branchName: "Main Branch" });
    const cashier = await loginAs(world.cashier);
    const pharmacist = await loginAs(
      await makeUser({
        branchId: world.branch.id,
        roleName: "pharmacist",
        permissions: ROLE_PERMISSIONS.pharmacist,
      }),
    );
    const admin = await loginAs(
      await makeUser({ roleName: "admin", permissions: ROLE_PERMISSIONS.admin }),
    );
    await makeSaleIn(world);

    const forCashier = (await cashier.get("/sales", HTML)).text;
    const forPharmacist = (await pharmacist.get("/sales", HTML)).text;
    const forAdmin = (await admin.get("/sales", HTML)).text;

    expect(forCashier).not.toContain('name="branchId"');
    expect(forCashier).not.toContain('name="cashierId"');
    expect(forPharmacist).not.toContain('name="branchId"');
    expect(forPharmacist).toContain('name="cashierId"');
    expect(forAdmin).toContain('name="branchId"');
    expect(forAdmin).toContain('name="cashierId"');
    expect(forAdmin).toContain("Main Branch");
    expect(forAdmin).toContain("Ana Reyes");
  });

  test("a user without sales permission is denied", async ({ expect }) => {
    const session = await loginAs(await makeUser({ permissions: ["dashboard.view"] }));

    expect((await session.get("/sales", HTML)).status).toBe(403);
  });
});

test.group("sale detail page", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  async function saleWithBatches(world) {
    const customer = await makeCustomer({ firstName: "Maria", lastName: "Santos" });
    const stock = await makeProduct({
      branchId: world.branch.id,
      name: "Syrup",
      units: [{ name: "Bottle", factor: "1", base: true, price: "50.0000" }],
      batches: [
        { quantity: "100", batchNumber: "BATCH-ONE", expirationDate: "2027-01-31" },
        { quantity: "100", batchNumber: "BATCH-TWO", expirationDate: "2027-03-31" },
      ],
    });

    return makeSaleIn(world, {
      invoiceNumber: "INV-DETAIL",
      customerId: customer.id,
      lines: [
        {
          productId: stock.product.id,
          productUnitId: stock.units[0].id,
          productName: "Syrup",
          quantity: "20",
          unitPrice: "50.00",
          batches: [
            { batchId: stock.batches[0].id, quantity: "15" },
            { batchId: stock.batches[1].id, quantity: "5" },
          ],
        },
      ],
      payments: [{ method: "CASH", amount: "1000.00" }],
    });
  }

  test("shows the receipt with batches, payments and totals", async ({ expect }) => {
    const world = await makeWorld();
    const sale = await saleWithBatches(world);
    const session = await loginAs(world.cashier);

    const response = await session.get(`/sales/${sale.id}`, HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("INV-DETAIL");
    expect(response.text).toContain("Syrup");
    expect(response.text).toContain("BATCH-ONE");
    expect(response.text).toContain("BATCH-TWO");
    expect(response.text).toContain("2027-01-31");
    expect(response.text).toContain("Maria Santos");
    expect(response.text).toContain("Cash");
    expect(response.text).toContain("1,000.00");
    expect(response.text).not.toContain("Discount");
    expect(response.text).not.toContain(">Tax<");
    expect(response.text).toContain('data-auto-print="false"');
  });

  test("?print=1 marks the page to open the print dialog", async ({ expect }) => {
    const world = await makeWorld();
    const sale = await saleWithBatches(world);
    const session = await loginAs(world.cashier);

    const response = await session.get(`/sales/${sale.id}?print=1`, HTML);

    expect(response.text).toContain('data-auto-print="true"');
  });

  test("another cashier's sale and an unknown id are 404 pages", async ({ expect }) => {
    const world = await makeWorld();
    const sale = await saleWithBatches(world);
    const stranger = await loginAs(
      await makeUser({
        branchId: world.branch.id,
        roleName: "stranger",
        permissions: ROLE_PERMISSIONS.cashier,
      }),
    );

    const hidden = await stranger.get(`/sales/${sale.id}`, HTML);
    const unknown = await stranger.get("/sales/00000000-0000-4000-8000-000000000000", HTML);
    const malformed = await stranger.get("/sales/not-a-uuid", HTML);

    for (const response of [hidden, unknown, malformed]) {
      expect(response.status).toBe(404);
      expect(response.text).toContain("Page not found");
    }
  });
});

test.group("dashboard", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a cashier sees today's figures, the chart, the latest sales and a New sale button", async ({
    expect,
  }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { invoiceNumber: "TODAY-1", transactionDate: new Date() });
    await makeSaleIn(world, { invoiceNumber: "TODAY-2", transactionDate: new Date() });
    const session = await loginAs(world.cashier);

    const response = await session.get("/dashboard-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("Sales today");
    expect(response.text).toContain("Gross sales today");
    expect(response.text).toContain("20.00");
    expect(response.text).toContain("Daily gross sales");
    expect(response.text).toContain("Payment methods");
    expect(response.text).toContain("TODAY-1");
    expect(response.text).toContain('href="/pos-page"');
    expect(response.text).not.toContain("awaiting access");
  });

  test("the chart has a table view with one row per day", async ({ expect }) => {
    const world = await makeWorld();
    const session = await loginAs(world.cashier);

    const response = await session.get("/dashboard-page", HTML);
    const rows = response.text.match(/data-day-row/g) ?? [];

    expect(rows).toHaveLength(14);
  });

  test("a user with dashboard.view but no sales permission sees a notice, not figures", async ({
    expect,
  }) => {
    const session = await loginAs(await makeUser({ permissions: ["dashboard.view"] }));

    const response = await session.get("/dashboard-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("no sales figures");
    expect(response.text).not.toContain("Sales today");
    expect(response.text).not.toContain("awaiting access");
  });

  test("a user without any permission sees the awaiting-access notice", async ({ expect }) => {
    const session = await loginAs(await makeUser());

    const response = await session.get("/dashboard-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("awaiting access");
    expect(response.text).not.toContain("Sales today");
  });

  test("a signed-out visitor is sent to the login page", async ({ expect }) => {
    const response = await new TestSession().get("/dashboard-page", HTML);

    expect([response.status, response.location]).toEqual([302, "/login-page"]);
  });
});

test.group("html in names (review focus 5)", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("product, customer and cashier names are escaped on the list, detail and dashboard", async ({
    expect,
  }) => {
    const world = await makeWorld({ cashierName: XSS });
    const customer = await makeCustomer({ firstName: "Eve", lastName: XSS });
    const sale = await makeSaleIn(world, {
      customerId: customer.id,
      transactionDate: new Date(),
      lines: [
        {
          productId: world.product.id,
          productUnitId: world.unit.id,
          productName: XSS,
          quantity: "1",
          unitPrice: "10.00",
          batches: [],
        },
      ],
    });
    const admin = await loginAs(
      await makeUser({ roleName: "admin", permissions: ROLE_PERMISSIONS.admin }),
    );

    for (const path of ["/sales", `/sales/${sale.id}`, "/dashboard-page"]) {
      const response = await admin.get(path, HTML);

      expect([path, response.status]).toEqual([path, 200]);
      expect(response.text).not.toContain("<img src=x");
    }

    expect((await admin.get("/sales", HTML)).text).toContain("&lt;img");
    expect((await admin.get(`/sales/${sale.id}`, HTML)).text).toContain("&lt;img");
  });
});
