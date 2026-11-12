import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { businessDate } from "../../app/services/support/time.js";
import { resetDatabase } from "../helpers/db.js";
import { makeProduct, makeSaleIn, makeUser, makeWorld } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const SALE_KEYS = [
  "branch",
  "cashier",
  "customer",
  "id",
  "invoiceNumber",
  "itemCount",
  "paymentMethods",
  "register",
  "status",
  "totals",
  "transactionDate",
];

const invoicesOf = (response) => {
  return response.json().data.map((sale) => {
    return sale.invoiceNumber;
  });
};

test.group("sales API: access", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a request without a session is a 401 envelope", async ({ expect }) => {
    for (const path of ["/api/v1/sales", "/api/v1/sales/summary", "/api/v1/sales/some-id"]) {
      const response = await new TestSession().get(path);

      expect([path, response.status, response.json().error.code]).toEqual([
        path,
        401,
        "unauthenticated",
      ]);
    }
  });

  test("a user without any sales permission is a 403 envelope", async ({ expect }) => {
    const session = await loginAs(await makeUser({ permissions: ["dashboard.view"] }));

    const response = await session.get("/api/v1/sales");

    expect(response.status).toBe(403);
    expect(response.json().error.code).toBe("forbidden");
  });

  test("cashier, pharmacist and accountant see different slices", async ({ expect }) => {
    const main = await makeWorld({ branchCode: "MAIN" });
    const north = await makeWorld({ branchCode: "NORTH" });

    await makeSaleIn(main, { invoiceNumber: "M-1" });
    await makeSaleIn(main, {
      invoiceNumber: "M-2",
      cashierId: (await makeUser({ branchId: main.branch.id })).id,
    });
    await makeSaleIn(north, { invoiceNumber: "N-1" });

    const cashier = await loginAs(main.cashier);
    const pharmacist = await loginAs(
      await makeUser({
        branchId: main.branch.id,
        roleName: "pharmacist",
        permissions: ROLE_PERMISSIONS.pharmacist,
      }),
    );
    const accountant = await loginAs(
      await makeUser({ roleName: "accountant", permissions: ROLE_PERMISSIONS.accountant }),
    );

    expect(invoicesOf(await cashier.get("/api/v1/sales"))).toEqual(["M-1"]);
    expect(invoicesOf(await pharmacist.get("/api/v1/sales")).sort()).toEqual(["M-1", "M-2"]);
    expect(invoicesOf(await accountant.get("/api/v1/sales")).sort()).toEqual(["M-1", "M-2", "N-1"]);
    expect((await pharmacist.get(`/api/v1/sales?branchId=${north.branch.id}`)).status).toBe(403);
  });
});

test.group("sales API: list", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("returns the documented item shape with meta and links", async ({ expect }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { invoiceNumber: "S-1" });
    await makeSaleIn(world, { invoiceNumber: "S-2" });
    await makeSaleIn(world, { invoiceNumber: "S-3" });
    const session = await loginAs(world.cashier);

    const body = (await session.get("/api/v1/sales?perPage=2")).json();

    expect(Object.keys(body.data[0]).sort()).toEqual(SALE_KEYS);
    expect(body.data[0].transactionDate).toMatch(/Z$/);
    expect(body.data[0].totals).toEqual({
      subtotal: "10.00",
      discount: "0.00",
      tax: "0.00",
      total: "10.00",
      paid: "10.00",
      change: "0.00",
    });
    expect(body.meta).toEqual({ page: 1, perPage: 2, total: 3, totalPages: 2 });
    expect(body.links.prev).toBeNull();
    expect(body.links.next).toBe("/api/v1/sales?page=2&perPage=2");
  });

  test("filters and sorts through the query string", async ({ expect }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { invoiceNumber: "A-1", status: "VOIDED" });
    await makeSaleIn(world, { invoiceNumber: "B-2" });
    const session = await loginAs(world.cashier);

    expect(invoicesOf(await session.get("/api/v1/sales?status=VOIDED"))).toEqual(["A-1"]);
    expect(invoicesOf(await session.get("/api/v1/sales?sort=invoiceNumber"))).toEqual([
      "A-1",
      "B-2",
    ]);
    expect(invoicesOf(await session.get("/api/v1/sales?q=B-"))).toEqual(["B-2"]);
    expect(invoicesOf(await session.get("/api/v1/sales?status="))).toHaveLength(2);
  });

  test("invalid parameters are 422 envelopes naming the field", async ({ expect }) => {
    const world = await makeWorld();
    const session = await loginAs(world.cashier);
    const cases = {
      "perPage=101": "perPage",
      "page=0": "page",
      "page=abc": "page",
      "from=2026-11-12&to=2026-11-01": "from",
      "from=2026-02-30": "from",
      "status=NOPE": "status.0",
      "sort=hacker": "sort",
      "branchId=not-a-uuid": "branchId",
      [`q=${"x".repeat(101)}`]: "q",
      "paymentMethod=CHEQUE": "paymentMethod",
    };

    for (const [query, path] of Object.entries(cases)) {
      const response = await session.get(`/api/v1/sales?${query}`);

      expect([query.slice(0, 30), response.status, response.json().error.code]).toEqual([
        query.slice(0, 30),
        422,
        "validation_failed",
      ]);
      expect(
        response.json().error.details.map((detail) => {
          return detail.path;
        }),
      ).toContain(path);
    }
  });
});

test.group("sales API: detail", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("returns items with batch allocations that add up, and payments", async ({ expect }) => {
    const world = await makeWorld();
    const stock = await makeProduct({
      branchId: world.branch.id,
      name: "Syrup",
      units: [{ name: "Bottle", factor: "1", base: true, price: "50.0000" }],
      batches: [
        { quantity: "100", batchNumber: "B1", expirationDate: "2027-01-31" },
        { quantity: "100", batchNumber: "B2", expirationDate: "2027-03-31" },
      ],
    });
    const sale = await makeSaleIn(world, {
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
    const session = await loginAs(world.cashier);

    const response = await session.get(`/api/v1/sales/${sale.id}`);
    const detail = response.json().data;

    expect(response.status).toBe(200);
    expect(detail.items).toHaveLength(1);
    expect(
      detail.items[0].batches.reduce((total, batch) => {
        return total + Number(batch.quantity);
      }, 0),
    ).toBe(Number(detail.items[0].baseQuantity));
    expect(detail.payments).toEqual([
      expect.objectContaining({ method: "CASH", amount: "1000.00", status: "PAID" }),
    ]);
    expect(response.text).not.toContain("unitCost");
    expect(response.text.toLowerCase()).not.toContain("idempotency");
  });

  test("another cashier's sale and a malformed id are 404", async ({ expect }) => {
    const world = await makeWorld();
    const sale = await makeSaleIn(world);
    const stranger = await loginAs(
      await makeUser({
        branchId: world.branch.id,
        roleName: "stranger",
        permissions: ROLE_PERMISSIONS.cashier,
      }),
    );

    const hidden = await stranger.get(`/api/v1/sales/${sale.id}`);
    const malformed = await stranger.get("/api/v1/sales/not-a-uuid");

    expect([hidden.status, hidden.json().error.code]).toEqual([404, "not_found"]);
    expect([malformed.status, malformed.json().error.code]).toEqual([404, "not_found"]);
  });
});

test.group("sales API: summary", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("defaults to the last 30 business days and totals today's sales", async ({ expect }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { transactionDate: new Date() });
    const session = await loginAs(world.cashier);

    const response = await session.get("/api/v1/sales/summary");
    const { data } = response.json();

    expect(response.status).toBe(200);
    expect(data.period.to).toBe(businessDate(new Date()));
    expect(data.byDay).toHaveLength(30);
    expect(data.totals.salesCount).toBe(1);
    expect(data.totals.grossSales).toBe("10.00");
    expect(data.byPaymentMethod).toEqual([{ method: "CASH", paymentsCount: 1, amount: "10.00" }]);
  });

  test("rejects an invalid range", async ({ expect }) => {
    const session = await loginAs((await makeWorld()).cashier);

    const response = await session.get("/api/v1/sales/summary?from=2026-12-01&to=2026-11-01");

    expect(response.status).toBe(422);
  });
});
