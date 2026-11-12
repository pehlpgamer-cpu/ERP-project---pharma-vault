import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { db } from "../../database/client.js";
import { HttpError } from "../../app/http/errors.js";
import { refunds } from "../../app/models/refunds.js";
import { salesReturns } from "../../app/models/sales-returns.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import {
  getSale,
  getSummary,
  listSales,
  loadSaleDetail,
} from "../../app/services/sales/salesQuery.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeCustomer,
  makeProduct,
  makeSaleIn,
  makeWorld,
} from "../helpers/factories.js";

const NOW = new Date("2026-11-12T10:00:00Z");
const defaults = { page: 1, perPage: 20, sort: "-transactionDate" };
const filters = (overrides = {}) => {
  return { ...defaults, ...overrides };
};

const admin = () => {
  return makeAuthUser({ roleName: "admin", permissions: ROLE_PERMISSIONS.admin });
};

const invoices = (result) => {
  return result.rows.map((row) => {
    return row.invoiceNumber;
  });
};

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return null;
}

test.group("listSales", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("paginates with a stable total", async ({ expect }) => {
    const world = await makeWorld();
    const viewer = await admin();

    for (let index = 1; index <= 25; index++) {
      await makeSaleIn(world, {
        invoiceNumber: `S-${String(index).padStart(3, "0")}`,
        transactionDate: new Date(Date.UTC(2026, 10, 10, 0, index)),
      });
    }

    const third = await listSales(filters({ page: 3, perPage: 10 }), viewer);
    const beyond = await listSales(filters({ page: 9, perPage: 10 }), viewer);

    expect(third.rows).toHaveLength(5);
    expect(third.total).toBe(25);
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(25);
  });

  test("sorts newest first by default and by total on request", async ({ expect }) => {
    const world = await makeWorld();
    const viewer = await admin();
    const totals = { "S-A": "30.00", "S-B": "10.00", "S-C": "20.00" };
    let minute = 0;

    for (const [invoiceNumber, total] of Object.entries(totals)) {
      minute += 1;
      await makeSaleIn(world, {
        invoiceNumber,
        transactionDate: new Date(Date.UTC(2026, 10, 10, 0, minute)),
        lines: [
          {
            productId: world.product.id,
            productUnitId: world.unit.id,
            quantity: String(Number(total) / 10),
            unitPrice: "10.00",
            batches: [],
          },
        ],
        payments: [{ method: "CASH", amount: total }],
      });
    }

    expect(invoices(await listSales(filters(), viewer))).toEqual(["S-C", "S-B", "S-A"]);
    expect(invoices(await listSales(filters({ sort: "totalAmount" }), viewer))).toEqual([
      "S-B",
      "S-C",
      "S-A",
    ]);
    expect(invoices(await listSales(filters({ sort: "-totalAmount" }), viewer))).toEqual([
      "S-A",
      "S-C",
      "S-B",
    ]);
    expect(invoices(await listSales(filters({ sort: "invoiceNumber" }), viewer))).toEqual([
      "S-A",
      "S-B",
      "S-C",
    ]);
  });

  test("filters by status and by payment method", async ({ expect }) => {
    const world = await makeWorld();
    const viewer = await admin();

    await makeSaleIn(world, { invoiceNumber: "S-1", status: "COMPLETED" });
    await makeSaleIn(world, { invoiceNumber: "S-2", status: "VOIDED" });
    await makeSaleIn(world, { invoiceNumber: "S-3", status: "REFUNDED" });
    await makeSaleIn(world, {
      invoiceNumber: "S-4",
      payments: [
        { method: "GCASH", amount: "6.00", reference: "GC-1" },
        { method: "CASH", amount: "4.00" },
      ],
    });

    const voided = await listSales(filters({ status: ["VOIDED"] }), viewer);
    const two = await listSales(filters({ status: ["VOIDED", "REFUNDED"] }), viewer);
    const gcash = await listSales(filters({ paymentMethod: "GCASH" }), viewer);

    expect(invoices(voided)).toEqual(["S-2"]);
    expect(two.total).toBe(2);
    expect(invoices(gcash)).toEqual(["S-4"]);
    expect(gcash.rows[0].paymentMethods).toEqual(["CASH", "GCASH"]);
  });

  test("search treats %, _ and backslash literally (review focus 1)", async ({ expect }) => {
    const world = await makeWorld();
    const viewer = await admin();

    await makeSaleIn(world, { invoiceNumber: "MAIN-20261112-0001" });
    await makeSaleIn(world, { invoiceNumber: "MAIN-20261112-0002" });

    expect((await listSales(filters({ q: "%" }), viewer)).total).toBe(0);
    expect((await listSales(filters({ q: "_" }), viewer)).total).toBe(0);
    expect((await listSales(filters({ q: "MAIN-20261112" }), viewer)).total).toBe(2);

    await makeSaleIn(world, { invoiceNumber: "A_B%C" });
    await makeSaleIn(world, { invoiceNumber: "BS\\1" });

    expect(invoices(await listSales(filters({ q: "%" }), viewer))).toEqual(["A_B%C"]);
    expect(invoices(await listSales(filters({ q: "_B" }), viewer))).toEqual(["A_B%C"]);
    expect(invoices(await listSales(filters({ q: "\\" }), viewer))).toEqual(["BS\\1"]);
  });

  test("date filters follow the business day (review focus 2)", async ({ expect }) => {
    const world = await makeWorld();
    const viewer = await admin();

    // 2026-11-12T16:00:00Z is midnight at the start of Nov 13 in Asia/Manila.
    await makeSaleIn(world, {
      invoiceNumber: "LATE",
      transactionDate: new Date("2026-11-12T16:00:00Z"),
    });
    await makeSaleIn(world, {
      invoiceNumber: "EARLY",
      transactionDate: new Date("2026-11-12T15:59:59Z"),
    });

    const nov13 = await listSales(filters({ from: "2026-11-13", to: "2026-11-13" }), viewer);
    const nov12 = await listSales(filters({ from: "2026-11-12", to: "2026-11-12" }), viewer);

    expect(invoices(nov13)).toEqual(["LATE"]);
    expect(invoices(nov12)).toEqual(["EARLY"]);
  });

  test("scope limits the rows and rejects other branches and cashiers", async ({ expect }) => {
    const main = await makeWorld({ branchCode: "MAIN" });
    const north = await makeWorld({ branchCode: "NORTH", cashierName: "Nico Cashier" });
    const second = await makeWorld({ branchCode: "SECOND" });
    // a second cashier in MAIN
    const other = await makeAuthUser({
      branchId: main.branch.id,
      roleName: "cashier-main-2",
      permissions: ROLE_PERMISSIONS.cashier,
    });

    await makeSaleIn(main, { invoiceNumber: "M-1" });
    await makeSaleIn(main, { invoiceNumber: "M-2" });
    await makeSaleIn(main, { invoiceNumber: "M-3", cashierId: other.id });
    await makeSaleIn(north, { invoiceNumber: "N-1" });
    await makeSaleIn(second, { invoiceNumber: "S-1" });

    const cashier = await loadAuthUser(main.cashier.id);
    const own = await listSales(filters(), cashier);
    const pharmacist = await makeAuthUser({
      branchId: main.branch.id,
      roleName: "pharmacist",
      permissions: ROLE_PERMISSIONS.pharmacist,
    });
    const accountant = await makeAuthUser({
      roleName: "accountant",
      permissions: ROLE_PERMISSIONS.accountant,
    });

    expect(invoices(own).sort()).toEqual(["M-1", "M-2"]);
    expect(invoices(await listSales(filters(), pharmacist)).sort()).toEqual(["M-1", "M-2", "M-3"]);
    expect((await listSales(filters(), accountant)).total).toBe(5);
    expect(invoices(await listSales(filters({ branchId: north.branch.id }), accountant))).toEqual([
      "N-1",
    ]);

    const wrongBranch = await rejectionOf(
      listSales(filters({ branchId: north.branch.id }), pharmacist),
    );
    const wrongCashier = await rejectionOf(listSales(filters({ cashierId: other.id }), cashier));
    const wrongBranchOwn = await rejectionOf(
      listSales(filters({ branchId: north.branch.id }), cashier),
    );
    const nothing = await rejectionOf(
      listSales(filters(), await makeAuthUser({ permissions: ["dashboard.view"] })),
    );

    for (const error of [wrongBranch, wrongCashier, wrongBranchOwn, nothing]) {
      expect(error).toBeInstanceOf(HttpError);
      expect([error.status, error.code]).toEqual([403, "forbidden"]);
    }
  });
});

test.group("getSale", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("returns items with batch traceability, payments and the customer", async ({ expect }) => {
    const world = await makeWorld();
    const customer = await makeCustomer({ firstName: "Maria", lastName: "Santos" });
    const stock = await makeProduct({
      branchId: world.branch.id,
      name: "Amoxicillin-free Syrup",
      units: [{ name: "Bottle", factor: "1", base: true, price: "50.0000" }],
      batches: [
        { quantity: "100", batchNumber: "B1", expirationDate: "2027-01-31" },
        { quantity: "100", batchNumber: "B2", expirationDate: "2027-03-31" },
      ],
    });
    const sale = await makeSaleIn(world, {
      customerId: customer.id,
      lines: [
        {
          productId: stock.product.id,
          productUnitId: stock.units[0].id,
          productName: "Amoxicillin-free Syrup",
          quantity: "20",
          unitPrice: "50.00",
          batches: [
            { batchId: stock.batches[0].id, quantity: "15" },
            { batchId: stock.batches[1].id, quantity: "5" },
          ],
        },
      ],
      payments: [{ method: "CASH", amount: "1000.00" }],
      changeAmount: "0.00",
    });

    const detail = await loadSaleDetail(sale.id);

    expect(detail.invoiceNumber).toBe(sale.invoiceNumber);
    expect(detail.customer).toEqual({
      id: customer.id,
      customerNumber: customer.customerNumber,
      name: "Maria Santos",
    });
    expect(detail.register.code).toBe(world.register.registerCode);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      productName: "Amoxicillin-free Syrup",
      quantity: "20.000",
      baseQuantity: "20.000",
      unitPrice: "50.0000",
      subtotal: "1000.00",
      total: "1000.00",
      unit: { name: "Bottle" },
    });
    expect(
      detail.items[0].batches.map((batch) => {
        return [batch.batchNumber, batch.expirationDate, batch.quantity];
      }),
    ).toEqual([
      ["B1", "2027-01-31", "15.000"],
      ["B2", "2027-03-31", "5.000"],
    ]);
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]).toMatchObject({ method: "CASH", amount: "1000.00", status: "PAID" });
    expect(detail.totals).toMatchObject({ subtotal: "1000.00", total: "1000.00", paid: "1000.00" });
    expect(JSON.stringify(detail)).not.toContain("unitCost");
  });

  test("returns null for unknown ids and for sales outside the scope", async ({ expect }) => {
    const world = await makeWorld();
    const other = await makeAuthUser({
      branchId: world.branch.id,
      roleName: "other-cashier",
      permissions: ROLE_PERMISSIONS.cashier,
    });
    const sale = await makeSaleIn(world);
    const owner = await makeAuthUser({
      roleName: "owner-admin",
      permissions: ROLE_PERMISSIONS.admin,
    });

    expect(await getSale(randomUUID(), owner)).toBeNull();
    expect(await getSale(sale.id, other)).toBeNull();
    expect((await getSale(sale.id, owner)).id).toBe(sale.id);
    expect(await loadSaleDetail(randomUUID())).toBeNull();
  });
});

test.group("getSummary", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  async function fixture() {
    const world = await makeWorld();
    const zinc = await makeProduct({
      branchId: world.branch.id,
      name: "Zinc 20 mg Tablet",
      units: [{ name: "Tablet", factor: "1", base: true, price: "10.0000" }],
    });
    const line = (
      quantity,
      product = world.product,
      unit = world.unit,
      productName = "Paracetamol 500 mg Tablet",
    ) => {
      return {
        productId: product.id,
        productUnitId: unit.id,
        productName,
        quantity,
        unitPrice: "10.00",
        batches: [],
      };
    };
    const a = await makeSaleIn(world, {
      invoiceNumber: "A",
      transactionDate: new Date("2026-11-10T04:00:00Z"),
      lines: [line("18")],
      payments: [{ method: "CASH", amount: "200.00" }],
      changeAmount: "20.00",
    });
    const b = await makeSaleIn(world, {
      invoiceNumber: "B",
      transactionDate: new Date("2026-11-12T04:00:00Z"),
      lines: [line("10"), line("2", zinc.product, zinc.units[0], "Zinc 20 mg Tablet")],
      payments: [
        { method: "CASH", amount: "20.00" },
        { method: "GCASH", amount: "100.00", reference: "GC-1" },
      ],
    });
    await makeSaleIn(world, {
      invoiceNumber: "C",
      transactionDate: new Date("2026-11-12T05:00:00Z"),
      status: "VOIDED",
      lines: [line("5")],
      payments: [{ method: "CASH", amount: "50.00" }],
    });

    return { world, a, b };
  }

  test("totals, days, payment methods and top products match the fixtures", async ({ expect }) => {
    await fixture();
    const viewer = await admin();

    const data = await getSummary({ from: "2026-11-10", to: "2026-11-12" }, viewer, { now: NOW });

    expect(data.period).toEqual({ from: "2026-11-10", to: "2026-11-12", timezone: "Asia/Manila" });
    expect(data.totals).toEqual({
      salesCount: 2,
      grossSales: "300.00",
      discounts: "0.00",
      tax: "0.00",
      refunds: "0.00",
      netSales: "300.00",
      averageSale: "150.00",
      voidedCount: 1,
      voidedTotal: "50.00",
    });
    expect(data.byDay).toEqual([
      { date: "2026-11-10", salesCount: 1, grossSales: "180.00" },
      { date: "2026-11-11", salesCount: 0, grossSales: "0.00" },
      { date: "2026-11-12", salesCount: 1, grossSales: "120.00" },
    ]);
    expect(data.byPaymentMethod).toEqual([
      { method: "CASH", paymentsCount: 2, amount: "200.00" },
      { method: "GCASH", paymentsCount: 1, amount: "100.00" },
    ]);
    expect(data.topProducts).toEqual([
      expect.objectContaining({
        productName: "Paracetamol 500 mg Tablet",
        baseQuantity: "28.000",
        revenue: "280.00",
      }),
      expect.objectContaining({
        productName: "Zinc 20 mg Tablet",
        baseQuantity: "2.000",
        revenue: "20.00",
      }),
    ]);
  });

  test("a processed refund inside the period lowers the net", async ({ expect }) => {
    const { world, b } = await fixture();
    const viewer = await admin();
    const returnId = randomUUID();

    await db.insert(salesReturns).values({
      id: returnId,
      saleId: b.id,
      branchId: world.branch.id,
      returnNumber: "RET-1",
      returnReason: "test",
      status: "PROCESSED",
      processedBy: world.cashier.id,
    });
    await db.insert(refunds).values({
      salesReturnId: returnId,
      paymentMethod: "CASH",
      amount: "40.00",
      status: "PROCESSED",
      processedAt: new Date("2026-11-12T06:00:00Z"),
    });

    const data = await getSummary({ from: "2026-11-10", to: "2026-11-12" }, viewer, { now: NOW });

    expect(data.totals.refunds).toBe("40.00");
    expect(data.totals.netSales).toBe("260.00");
  });

  test("the default period is the last 30 business days", async ({ expect }) => {
    const data = await getSummary({}, await admin(), { now: NOW });

    expect(data.period).toEqual({ from: "2026-10-14", to: "2026-11-12", timezone: "Asia/Manila" });
    expect(data.byDay).toHaveLength(30);
    expect(data.totals.salesCount).toBe(0);
    expect(data.totals.averageSale).toBe("0.00");
  });

  test("a sale at the business-day boundary lands on the next day (review focus 2)", async ({
    expect,
  }) => {
    const world = await makeWorld();
    await makeSaleIn(world, { transactionDate: new Date("2026-11-12T16:00:00Z") });

    const data = await getSummary({ from: "2026-11-12", to: "2026-11-13" }, await admin(), {
      now: NOW,
    });

    expect(data.byDay).toEqual([
      { date: "2026-11-12", salesCount: 0, grossSales: "0.00" },
      { date: "2026-11-13", salesCount: 1, grossSales: "10.00" },
    ]);
  });

  test("a cashier's summary only counts their own sales and none is forbidden", async ({
    expect,
  }) => {
    const { world } = await fixture();
    const owner = await loadAuthUser(world.cashier.id);
    const cashier = await makeAuthUser({
      branchId: world.branch.id,
      roleName: "someone-else",
      permissions: ROLE_PERMISSIONS.cashier,
    });

    const ownSummary = await getSummary({ from: "2026-11-10", to: "2026-11-12" }, owner, {
      now: NOW,
    });
    const strangerSummary = await getSummary({ from: "2026-11-10", to: "2026-11-12" }, cashier, {
      now: NOW,
    });
    const denied = await rejectionOf(
      getSummary({}, await makeAuthUser({ permissions: ["dashboard.view"] }), { now: NOW }),
    );

    expect(ownSummary.totals.salesCount).toBe(2);
    expect(strangerSummary.totals.salesCount).toBe(0);
    expect([denied.status, denied.code]).toEqual([403, "forbidden"]);
  });
});
