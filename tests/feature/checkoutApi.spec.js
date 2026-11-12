import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { sales } from "../../app/models/sales.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeCustomer,
  makeOpenSession,
  makeProduct,
  makeRegister,
  makeUser,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

// MAIN branch, a cashier with an open register session, and a tablet at 3.50 with one batch.
async function counter({ stock = "100.000" } = {}) {
  const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
  const cashier = await makeUser({
    branchId: branch.id,
    roleName: "cashier-api",
    permissions: ROLE_PERMISSIONS.cashier,
    name: "Ana Reyes",
  });
  const register = await makeRegister({ branchId: branch.id });
  const session = await makeOpenSession({ registerId: register.id, cashierId: cashier.id });
  const stocked = await makeProduct({
    branchId: branch.id,
    name: "Paracetamol 500 mg Tablet",
    units: [{ name: "Tablet", factor: "1", base: true, price: "3.5000" }],
    batches: [{ quantity: stock, unitCost: "1.2000" }],
  });

  return {
    branch,
    cashier,
    session,
    product: stocked.product,
    tablet: stocked.units[0],
    batch: stocked.batches[0],
    http: await loginAs(cashier),
  };
}

const many = (count, value) => {
  return Array.from({ length: count }, () => {
    return value;
  });
};

const sale = (ctx, overrides = {}) => {
  return {
    items: [{ productUnitId: ctx.tablet.id, quantity: "10" }],
    payments: [{ method: "CASH", amount: "50" }],
    ...overrides,
  };
};

function post(http, body, key = randomUUID(), headers = {}) {
  return http.post("/api/v1/sales", {
    json: body,
    headers: key === null ? headers : { "idempotency-key": key, ...headers },
  });
}

async function stockOf(ctx) {
  const [row] = await db
    .select()
    .from(inventoryBatches)
    .where(eq(inventoryBatches.id, ctx.batch.id));

  return row.quantityAvailable;
}

async function saleCount() {
  return (await db.select({ id: sales.id }).from(sales)).length;
}

test.group("checkout API: a completed sale", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("201 with the sale detail, the same key again 200 with the same sale", async ({
    expect,
  }) => {
    const ctx = await counter();
    const key = randomUUID();

    const first = await post(ctx.http, sale(ctx), key);
    const detail = first.json().data;
    const fetched = await ctx.http.get(`/api/v1/sales/${detail.id}`);
    const again = await post(ctx.http, sale(ctx), key);

    expect(first.status).toBe(201);
    expect(detail).toMatchObject({
      status: "COMPLETED",
      itemCount: 1,
      paymentMethods: ["CASH"],
      totals: { subtotal: "35.00", total: "35.00", paid: "50.00", change: "15.00" },
    });
    expect(detail.items[0]).toMatchObject({
      productName: "Paracetamol 500 mg Tablet",
      quantity: "10.000",
      baseQuantity: "10.000",
      unitPrice: "3.5000",
    });
    expect(detail.payments[0]).toMatchObject({ method: "CASH", amount: "50.00", status: "PAID" });
    expect(fetched.json().data).toEqual(detail);
    expect(again.status).toBe(200);
    expect(again.json().data.id).toBe(detail.id);
    expect(await stockOf(ctx)).toBe("90.000");
    expect(await saleCount()).toBe(1);
  });

  test("a customer, a reference and a split payment are accepted", async ({ expect }) => {
    const ctx = await counter();
    const customer = await makeCustomer();

    const response = await post(
      ctx.http,
      sale(ctx, {
        customerId: customer.id,
        payments: [
          { method: "CASH", amount: "20.00" },
          { method: "GCASH", amount: "15.00", reference: "  GC-77  " },
        ],
      }),
    );

    const payments = response.json().data.payments;
    const electronic = payments.find((payment) => {
      return payment.method === "GCASH";
    });

    expect(response.status).toBe(201);
    expect(response.json().data.customer).toMatchObject({ id: customer.id });
    expect(payments).toHaveLength(2);
    expect(electronic.reference).toBe("GC-77");
  });

  test("50 lines are accepted", async ({ expect }) => {
    const ctx = await counter();
    const items = many(50, { productUnitId: ctx.tablet.id, quantity: "1" });

    const response = await post(
      ctx.http,
      sale(ctx, { items, payments: [{ method: "CASH", amount: "200" }] }),
    );

    expect(response.status).toBe(201);
    expect(response.json().data.totals.total).toBe("175.00");
    expect(await stockOf(ctx)).toBe("50.000");
  });
});

test.group("checkout API: access and request shape", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a missing or malformed Idempotency-Key is a 422 and nothing is sold", async ({
    expect,
  }) => {
    const ctx = await counter();

    for (const key of [null, "not-a-uuid", "", "é"]) {
      const response = await post(ctx.http, sale(ctx), key);

      expect([key, response.status, response.json().error.code]).toEqual([
        key,
        422,
        "validation_failed",
      ]);
    }

    expect(await stockOf(ctx)).toBe("100.000");
    expect(await saleCount()).toBe(0);
  });

  test("only application/json is accepted: a form or text/plain body is a 422", async ({
    expect,
  }) => {
    const ctx = await counter();
    const key = { "idempotency-key": randomUUID() };

    const form = await ctx.http.post("/api/v1/sales", {
      form: { items: "x", payments: "y" },
      headers: key,
    });
    const text = await ctx.http.post("/api/v1/sales", {
      body: JSON.stringify(sale(ctx)),
      headers: { ...key, "content-type": "text/plain" },
    });
    const none = await ctx.http.post("/api/v1/sales", { headers: key });

    for (const response of [form, text, none]) {
      expect([response.status, response.json().error.code]).toEqual([422, "validation_failed"]);
    }

    expect(await saleCount()).toBe(0);
  });

  test("an accountant is 403 and a signed-out request is 401", async ({ expect }) => {
    const ctx = await counter();
    const accountant = await loginAs(
      await makeUser({
        branchId: ctx.branch.id,
        roleName: "accountant-api",
        permissions: ROLE_PERMISSIONS.accountant,
      }),
    );

    const denied = await post(accountant, sale(ctx));
    const anonymous = await post(new TestSession(), sale(ctx));

    expect([denied.status, denied.json().error.code]).toEqual([403, "forbidden"]);
    expect([anonymous.status, anonymous.json().error.code]).toEqual([401, "unauthenticated"]);
    expect(await saleCount()).toBe(0);
  });

  test("a cashier with no open register session gets 409 register_closed", async ({ expect }) => {
    const ctx = await counter();
    const idle = await loginAs(
      await makeUser({
        branchId: ctx.branch.id,
        roleName: "cashier-api",
        permissions: ROLE_PERMISSIONS.cashier,
      }),
    );

    const response = await post(idle, sale(ctx));

    expect([response.status, response.json().error.code]).toEqual([409, "register_closed"]);
  });

  test("not enough stock is a 409 with the figures, and a prescription product a 422", async ({
    expect,
  }) => {
    const ctx = await counter({ stock: "5.000" });
    const rx = await makeProduct({
      branchId: ctx.branch.id,
      name: "Amoxicillin",
      classification: "PRESCRIPTION",
      requiresPrescription: true,
      units: [{ name: "Capsule", factor: "1", base: true, price: "8.0000" }],
      batches: [{ quantity: "50.000" }],
    });

    const short = await post(ctx.http, sale(ctx));
    const prescription = await post(
      ctx.http,
      sale(ctx, { items: [{ productUnitId: rx.units[0].id, quantity: "1" }] }),
    );

    expect(short.status).toBe(409);
    expect(short.json().error).toMatchObject({
      code: "insufficient_stock",
      details: [{ productId: ctx.product.id, requested: "10.000", available: "5.000" }],
    });
    expect([prescription.status, prescription.json().error.code]).toEqual([
      422,
      "prescription_required",
    ]);
    expect(await stockOf(ctx)).toBe("5.000");
    expect(await saleCount()).toBe(0);
  });

  test("a payment that does not cover the sale is a 422 payment_invalid", async ({ expect }) => {
    const ctx = await counter();

    const response = await post(
      ctx.http,
      sale(ctx, { payments: [{ method: "CASH", amount: "10" }] }),
    );

    expect([response.status, response.json().error.code]).toEqual([422, "payment_invalid"]);
    expect(await stockOf(ctx)).toBe("100.000");
  });
});

test.group("checkout API: malformed or extreme input (review focus 3)", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  async function expectRejected(ctx, label, response) {
    return {
      label,
      status: response.status,
      code: response.json().error.code,
      stock: await stockOf(ctx),
      sales: await saleCount(),
    };
  }

  test("bad quantities are a 422 envelope and change no stock", async ({ expect }) => {
    const ctx = await counter();

    for (const quantity of [
      "0",
      "0.000",
      "-1",
      "abc",
      "",
      " ",
      "0.0001",
      "1e3",
      "99999999999999999999",
      "1,5",
      "+1",
      2,
      null,
      [],
    ]) {
      const response = await post(
        ctx.http,
        sale(ctx, { items: [{ productUnitId: ctx.tablet.id, quantity }] }),
      );

      expect(await expectRejected(ctx, String(quantity), response)).toEqual({
        label: String(quantity),
        status: 422,
        code: "validation_failed",
        stock: "100.000",
        sales: 0,
      });
    }
  });

  test("bad lines, payments and bodies are a 422 envelope and change no stock", async ({
    expect,
  }) => {
    const ctx = await counter();
    const line = { productUnitId: ctx.tablet.id, quantity: "1" };
    const cash = { method: "CASH", amount: "50" };
    const bodies = {
      "51 lines": sale(ctx, { items: many(51, line) }),
      "no lines": sale(ctx, { items: [] }),
      "missing lines": { payments: [cash] },
      "lines not a list": sale(ctx, { items: line }),
      "unit not a uuid": sale(ctx, { items: [{ productUnitId: "tablet", quantity: "1" }] }),
      "no unit": sale(ctx, { items: [{ quantity: "1" }] }),
      "no payments": sale(ctx, { payments: [] }),
      "missing payments": { items: [line] },
      "11 payments": sale(ctx, { payments: many(11, cash) }),
      "unknown method": sale(ctx, { payments: [{ method: "BITCOIN", amount: "50" }] }),
      "zero amount": sale(ctx, { payments: [{ method: "CASH", amount: "0" }] }),
      "negative amount": sale(ctx, { payments: [{ method: "CASH", amount: "-5" }] }),
      "three decimals": sale(ctx, { payments: [{ method: "CASH", amount: "10.005" }] }),
      "huge amount": sale(ctx, { payments: [{ method: "CASH", amount: "9999999999999" }] }),
      "numeric amount": sale(ctx, { payments: [{ method: "CASH", amount: 50 }] }),
      "long reference": sale(ctx, {
        payments: [{ method: "GCASH", amount: "50", reference: "x".repeat(151) }],
      }),
      "customer not a uuid": sale(ctx, { customerId: "ana" }),
      "an array body": [],
      "a string body": "sale",
    };

    for (const [label, body] of Object.entries(bodies)) {
      const response = await post(ctx.http, body);

      expect(await expectRejected(ctx, label, response)).toEqual({
        label,
        status: 422,
        code: "validation_failed",
        stock: "100.000",
        sales: 0,
      });
    }
  });

  test("a malformed JSON body is a 422 envelope", async ({ expect }) => {
    const ctx = await counter();

    const response = await ctx.http.post("/api/v1/sales", {
      body: "{bad",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    });

    expect([response.status, response.json().error.code]).toEqual([422, "validation_failed"]);
    expect(await stockOf(ctx)).toBe("100.000");
  });

  test("an unknown unit or customer is a 422, and so is a quantity no payment could cover", async ({
    expect,
  }) => {
    const ctx = await counter();

    const unknownUnit = await post(
      ctx.http,
      sale(ctx, { items: [{ productUnitId: randomUUID(), quantity: "1" }] }),
    );
    const unknownCustomer = await post(ctx.http, sale(ctx, { customerId: randomUUID() }));
    const huge = await post(
      ctx.http,
      sale(ctx, { items: [{ productUnitId: ctx.tablet.id, quantity: "999999999999" }] }),
    );

    expect([unknownUnit.status, unknownUnit.json().error.code]).toEqual([422, "validation_failed"]);
    expect([unknownCustomer.status, unknownCustomer.json().error.code]).toEqual([
      422,
      "validation_failed",
    ]);
    // the total of 999999999999 tablets is more than any payment can be, so the payments are refused
    // before any stock is looked at
    expect([huge.status, huge.json().error.code]).toEqual([422, "payment_invalid"]);
    expect(await stockOf(ctx)).toBe("100.000");
    expect(await saleCount()).toBe(0);
  });
});

test.group("checkout API: a double click (review focus 4)", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("two POSTs with the same key at once are one sale: statuses 200 and 201, one stock decrement", async ({
    expect,
  }) => {
    for (let round = 0; round < 3; round += 1) {
      await resetDatabase();
      const ctx = await counter();
      const key = randomUUID();

      const [one, two] = await Promise.all([
        post(ctx.http, sale(ctx), key),
        post(ctx.http, sale(ctx), key),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 201]);
      expect(one.json().data.id).toBe(two.json().data.id);
      expect(await saleCount()).toBe(1);
      expect(await stockOf(ctx)).toBe("90.000");
    }
  });
});
