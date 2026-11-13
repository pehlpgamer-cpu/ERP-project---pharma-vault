import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { dispensingItems } from "../../app/models/dispensing-items.js";
import { dispensings } from "../../app/models/dispensings.js";
import { inventoryBatches } from "../../app/models/inventory-batches.js";
import { prescribingPhysicians } from "../../app/models/prescribing-physicians.js";
import { prescriptionItems } from "../../app/models/prescription-items.js";
import { prescriptions } from "../../app/models/prescriptions.js";
import { salePrescriptions } from "../../app/models/sale-prescriptions.js";
import { sales } from "../../app/models/sales.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { createSale } from "../../app/services/sales/checkout.js";
import {
  getPrescription,
  listPrescriptions,
  lookupDispensable,
  recordPrescription,
  rejectPrescription,
  revokePrescription,
  verifyPrescription,
} from "../../app/services/sales/prescriptions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeBranch,
  makeCustomer,
  makeOpenSession,
  makeProduct,
  makeRegister,
} from "../helpers/factories.js";

const NOW = new Date("2026-11-12T03:00:00Z"); // 11:00 on 2026-11-12 in Asia/Manila

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

// MAIN: a cashier with an open register, a pharmacist, an accountant; a prescription-only capsule
// (12.00 each, 1000 in stock), an OTC tablet, and a customer.
async function setup() {
  const branch = await makeBranch({ code: "MAIN" });
  const cashier = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.cashier,
  });
  const pharmacist = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const accountant = await makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.accountant,
  });
  const register = await makeRegister({ branchId: branch.id });

  await makeOpenSession({ registerId: register.id, cashierId: cashier.id });

  const rx = await makeProduct({
    branchId: branch.id,
    name: "Amoxicillin 500 mg Capsule",
    classification: "PRESCRIPTION",
    requiresPrescription: true,
    units: [{ name: "Capsule", factor: "1", base: true, price: "12.0000" }],
    batches: [{ quantity: "1000", batchNumber: "AMOX-1" }],
  });
  const otc = await makeProduct({
    branchId: branch.id,
    name: "Paracetamol 500 mg Tablet",
    units: [{ name: "Tablet", factor: "1", base: true, price: "3.5000" }],
    batches: [{ quantity: "1000", batchNumber: "PARA-1" }],
  });
  const other = await makeProduct({
    branchId: branch.id,
    name: "Cetirizine 10 mg Tablet",
    classification: "PRESCRIPTION",
    requiresPrescription: true,
    units: [{ name: "Tablet", factor: "1", base: true, price: "5.0000" }],
    batches: [{ quantity: "100", batchNumber: "CETI-1" }],
  });

  return {
    branch,
    cashier,
    pharmacist,
    accountant,
    rx,
    otc,
    other,
    customer: await makeCustomer(),
  };
}

const physician = { fullName: "Dr. Maria Santos", licenseNumber: "PRC-12345" };

const rxInput = (ctx, overrides = {}) => {
  return {
    physician,
    customerNumber: ctx.customer.customerNumber,
    prescriptionDate: "2026-11-10",
    validUntil: "2026-12-10",
    items: [
      {
        sku: ctx.rx.product.sku,
        prescribedQuantity: "30",
        dosageInstructions: "1 capsule three times a day",
        frequency: "3x daily",
        duration: "10 days",
      },
    ],
    ...overrides,
  };
};

const record = (ctx, overrides) => {
  return recordPrescription(ctx.cashier, rxInput(ctx, overrides), { now: NOW });
};

async function verified(ctx, overrides) {
  const { id } = await record(ctx, overrides);

  await verifyPrescription(ctx.pharmacist, id, {}, { now: NOW });

  return id;
}

const sell = (ctx, prescriptionId, quantity, product = ctx.rx, amount = null) => {
  const total = (Number(quantity) * Number(product.units[0].price ?? 12)).toFixed(2);

  return createSale(
    ctx.cashier,
    {
      customerId: null,
      prescriptionId,
      items: [{ productUnitId: product.units[0].id, quantity }],
      payments: [{ method: "CASH", amount: amount ?? total, reference: null }],
    },
    randomUUID(),
    { now: NOW },
  );
};

const itemOf = async (id) => {
  const [row] = await db
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, id));

  return row;
};

const statusOf = async (id) => {
  const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, id));

  return row.status;
};

test.group("prescriptions", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("recording a prescription numbers it, reuses the physician and links the customer", async ({
    expect,
  }) => {
    const ctx = await setup();
    const first = await record(ctx);
    const second = await record(ctx);
    const { prescription, items } = await getPrescription(ctx.cashier, first.id);

    expect(first.prescriptionNumber).toBe("RX-MAIN-20261112-0001");
    expect(second.prescriptionNumber).toBe("RX-MAIN-20261112-0002");
    expect(prescription).toMatchObject({
      status: "PENDING_VERIFICATION",
      physicianName: "Dr. Maria Santos",
      licenseNumber: "PRC-12345",
      customerNumber: ctx.customer.customerNumber,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sku: ctx.rx.product.sku,
      prescribedQuantity: "30.000",
      dispensedQuantity: "0.000",
      remainingQuantity: "30.000",
    });
    expect(await db.select().from(prescribingPhysicians)).toHaveLength(1);
  });

  test("a prescription is refused for bad physicians, dates, items and customers", async ({
    expect,
  }) => {
    const ctx = await setup();
    const paths = async (overrides) => {
      return (await failure(record(ctx, overrides))).details.map((detail) => {
        return detail.path;
      });
    };

    await record(ctx);

    expect(
      await paths({ physician: { fullName: "Dr. Someone Else", licenseNumber: "PRC-12345" } }),
    ).toContain("physician.licenseNumber");
    expect(await paths({ physician: { fullName: "", licenseNumber: "" } })).toEqual(
      expect.arrayContaining(["physician.fullName", "physician.licenseNumber"]),
    );
    expect(await paths({ prescriptionDate: "2026-13-40" })).toContain("prescriptionDate");
    expect(await paths({ prescriptionDate: "2026-11-20" })).toContain("prescriptionDate");
    expect(await paths({ validUntil: "2026-11-01" })).toContain("validUntil");
    expect(await paths({ customerNumber: "NOBODY" })).toContain("customerNumber");
    expect(await paths({ items: [] })).toContain("items");
    expect(
      await paths({ items: [{ sku: "NOPE", prescribedQuantity: "1", dosageInstructions: "x" }] }),
    ).toContain("items.0.sku");
    expect(
      await paths({
        items: [{ sku: ctx.rx.product.sku, prescribedQuantity: "0", dosageInstructions: "" }],
      }),
    ).toEqual(expect.arrayContaining(["items.0.prescribedQuantity", "items.0.dosageInstructions"]));
    expect(
      (await failure(recordPrescription(ctx.accountant, rxInput(ctx), { now: NOW }))).status,
    ).toBe(403);
  });

  test("only a pharmacist verifies or rejects, once, and not after it expired", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await record(ctx);

    expect((await failure(verifyPrescription(ctx.cashier, id, {}, { now: NOW }))).status).toBe(403);

    await verifyPrescription(ctx.pharmacist, id, {}, { now: NOW });

    const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, id));

    expect(row).toMatchObject({ status: "VERIFIED", verifiedBy: ctx.pharmacist.id });
    expect(row.verifiedAt).not.toBeNull();
    expect((await failure(verifyPrescription(ctx.pharmacist, id, {}, { now: NOW }))).code).toBe(
      "prescription_state",
    );

    const second = await record(ctx);

    expect(
      (await failure(rejectPrescription(ctx.pharmacist, second.id, {}, { now: NOW }))).details[0]
        .path,
    ).toBe("reason");

    await rejectPrescription(
      ctx.pharmacist,
      second.id,
      { reason: "Altered quantity" },
      { now: NOW },
    );

    expect(await statusOf(second.id)).toBe("REJECTED");
    expect(
      (await failure(verifyPrescription(ctx.pharmacist, second.id, {}, { now: NOW }))).status,
    ).toBe(409);

    const old = await record(ctx, { prescriptionDate: "2026-09-01", validUntil: "2026-10-01" });
    const late = await failure(verifyPrescription(ctx.pharmacist, old.id, {}, { now: NOW }));

    expect(late.code).toBe("prescription_expired");
    expect((await getPrescription(ctx.cashier, old.id)).prescription.status).toBe("EXPIRED");
  });

  test("a checkout dispenses against a verified prescription and tracks what is left", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await record(ctx);

    expect((await failure(sell(ctx, id, "10"))).code).toBe("prescription_invalid");

    await verifyPrescription(ctx.pharmacist, id, {}, { now: NOW });

    const { saleId } = await sell(ctx, id, "10");
    const [sale] = await db.select().from(sales).where(eq(sales.id, saleId));
    const [dispensing] = await db.select().from(dispensings);
    const [part] = await db.select().from(dispensingItems);
    const [link] = await db.select().from(salePrescriptions);
    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.batchNumber, "AMOX-1"));

    expect(sale.customerId).toBe(ctx.customer.id);
    expect(dispensing).toMatchObject({
      prescriptionId: id,
      saleId,
      pharmacistId: ctx.pharmacist.id,
      status: "COMPLETED",
    });
    expect(part).toMatchObject({ quantityDispensed: "10.000", productId: ctx.rx.product.id });
    expect(link).toMatchObject({ saleId, prescriptionId: id });
    expect(batch.quantityAvailable).toBe("990.000");
    expect((await itemOf(id)).totalDispensedQuantity).toBe("10.000");
    expect(await statusOf(id)).toBe("PARTIALLY_DISPENSED");

    await sell(ctx, id, "20");

    expect((await itemOf(id)).totalDispensedQuantity).toBe("30.000");
    expect(await statusOf(id)).toBe("FULLY_DISPENSED");
    expect((await failure(sell(ctx, id, "1"))).code).toBe("prescription_invalid");
  });

  test("more than the prescription allows is refused and nothing is written", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await verified(ctx);
    const error = await failure(sell(ctx, id, "31"));

    expect(error.status).toBe(409);
    expect(error.code).toBe("prescription_quantity");
    expect(await db.select().from(sales)).toHaveLength(0);
    expect((await itemOf(id)).totalDispensedQuantity).toBe("0.000");
  });

  test("products not on the prescription or foreign prescriptions are refused", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await verified(ctx);
    const offList = await failure(sell(ctx, id, "1", ctx.other));
    const unknown = await failure(sell(ctx, randomUUID(), "1"));
    const stranger = await makeCustomer({ firstName: "Ben", lastName: "Cruz" });
    const mismatch = await failure(
      createSale(
        ctx.cashier,
        {
          customerId: stranger.id,
          prescriptionId: id,
          items: [{ productUnitId: ctx.rx.units[0].id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "12.00", reference: null }],
        },
        randomUUID(),
        { now: NOW },
      ),
    );

    expect(offList.code).toBe("prescription_required");
    expect(unknown.details[0].path).toBe("prescriptionId");
    expect(mismatch.details[0].path).toBe("customerId");
    expect(await db.select().from(sales)).toHaveLength(0);
  });

  test("over-the-counter lines can ride along and never use up the prescription", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await verified(ctx);

    await createSale(
      ctx.cashier,
      {
        customerId: null,
        prescriptionId: id,
        items: [
          { productUnitId: ctx.rx.units[0].id, quantity: "5" },
          { productUnitId: ctx.otc.units[0].id, quantity: "4" },
        ],
        payments: [{ method: "CASH", amount: "74.00", reference: null }],
      },
      randomUUID(),
      { now: NOW },
    );

    expect((await itemOf(id)).totalDispensedQuantity).toBe("5.000");
    expect(await db.select().from(dispensingItems)).toHaveLength(1);
  });

  test("a prescription no item needs is simply not attached", async ({ expect }) => {
    const ctx = await setup();
    const id = await verified(ctx);

    await sell(ctx, id, "2", ctx.otc);

    expect(await db.select().from(dispensings)).toHaveLength(0);
    expect(await statusOf(id)).toBe("VERIFIED");
    expect(await db.select().from(salePrescriptions)).toHaveLength(0);
  });

  test("an over-the-counter product on the prescription does not keep it open", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await verified(ctx, {
      items: [
        {
          sku: ctx.rx.product.sku,
          prescribedQuantity: "30",
          dosageInstructions: "1 capsule three times a day",
        },
        { sku: ctx.otc.product.sku, prescribedQuantity: "10", dosageInstructions: "as needed" },
      ],
    });

    await sell(ctx, id, "30");

    expect(await statusOf(id)).toBe("FULLY_DISPENSED");
    expect((await failure(sell(ctx, id, "1"))).code).toBe("prescription_invalid");
  });

  test("a verified prescription can be revoked, with a reason, and stops being dispensable", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await verified(ctx);
    const byCashier = await failure(
      revokePrescription(ctx.cashier, id, { reason: "x" }, { now: NOW }),
    );
    const noReason = await failure(revokePrescription(ctx.pharmacist, id, {}, { now: NOW }));

    expect(byCashier.status).toBe(403);
    expect(noReason.details[0].path).toBe("reason");

    await sell(ctx, id, "5");
    await revokePrescription(ctx.pharmacist, id, { reason: "Altered quantity" }, { now: NOW });

    expect(await statusOf(id)).toBe("REJECTED");
    expect((await failure(sell(ctx, id, "1"))).code).toBe("prescription_invalid");
  });

  test("a physician is matched by license despite Dr., case and punctuation", async ({
    expect,
  }) => {
    const ctx = await setup();

    await record(ctx);
    await record(ctx, { physician: { fullName: "maria  santos", licenseNumber: "PRC-12345" } });
    await record(ctx, {
      physician: { fullName: "Dra. Maria Santos.", licenseNumber: "PRC-12345" },
    });

    expect(await db.select().from(prescribingPhysicians)).toHaveLength(1);
  });

  test("a box counts as its base units and two lines of one product are summed", async ({
    expect,
  }) => {
    const ctx = await setup();
    const boxed = await makeProduct({
      branchId: ctx.branch.id,
      name: "Azithromycin 500 mg Tablet",
      classification: "PRESCRIPTION",
      requiresPrescription: true,
      units: [
        { name: "Tablet", factor: "1", base: true, price: "20.0000" },
        { name: "Box", factor: "10", price: "180.0000" },
      ],
      batches: [{ quantity: "500", batchNumber: "AZI-1" }],
    });
    const id = await verified(ctx, {
      items: [{ sku: boxed.product.sku, prescribedQuantity: "30", dosageInstructions: "1 daily" }],
    });
    const call = (lines) => {
      return createSale(
        ctx.cashier,
        {
          customerId: null,
          prescriptionId: id,
          items: lines,
          payments: [{ method: "CASH", amount: "1000.00", reference: null }],
        },
        randomUUID(),
        { now: NOW },
      );
    };
    const box = { productUnitId: boxed.units[1].id, quantity: "2" };
    const loose = (quantity) => {
      return { productUnitId: boxed.units[0].id, quantity };
    };

    // 2 boxes (20 tablets) + 11 loose tablets = 31 > 30
    expect((await failure(call([box, loose("11")]))).code).toBe("prescription_quantity");

    await call([box, loose("10")]);

    expect((await itemOf(id)).totalDispensedQuantity).toBe("30.000");
    expect(await statusOf(id)).toBe("FULLY_DISPENSED");
  });

  test("a prescription that expired cannot be dispensed", async ({ expect }) => {
    const ctx = await setup();
    const id = await verified(ctx, { validUntil: "2026-11-12" });

    await sell(ctx, id, "1");

    const next = await failure(
      createSale(
        ctx.cashier,
        {
          customerId: null,
          prescriptionId: id,
          items: [{ productUnitId: ctx.rx.units[0].id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "12.00", reference: null }],
        },
        randomUUID(),
        { now: new Date("2026-11-13T03:00:00Z") },
      ),
    );

    expect(next.code).toBe("prescription_expired");
  });

  test("two sales at once cannot dispense more than was prescribed", async ({ expect }) => {
    const ctx = await setup();
    const id = await verified(ctx);
    const runs = await Promise.allSettled([sell(ctx, id, "20"), sell(ctx, id, "20")]);
    const won = runs.filter((run) => {
      return run.status === "fulfilled";
    });

    expect(won).toHaveLength(1);
    expect((await itemOf(id)).totalDispensedQuantity).toBe("20.000");
    expect(await db.select().from(sales)).toHaveLength(1);
  });

  test("the POS lookup returns a dispensable prescription with what is left", async ({
    expect,
  }) => {
    const ctx = await setup();
    const pending = await record(ctx);

    expect(
      (await failure(lookupDispensable(ctx.cashier, pending.prescriptionNumber, { now: NOW })))
        .code,
    ).toBe("prescription_invalid");
    expect((await failure(lookupDispensable(ctx.cashier, "RX-NOPE", { now: NOW }))).status).toBe(
      404,
    );

    const id = await verified(ctx);
    const [{ prescriptionNumber }] = await db
      .select()
      .from(prescriptions)
      .where(eq(prescriptions.id, id));

    await sell(ctx, id, "10");

    const found = await lookupDispensable(ctx.cashier, prescriptionNumber.toLowerCase(), {
      now: NOW,
    });

    expect(found).toMatchObject({ id, prescriptionNumber, customerName: expect.any(String) });
    expect(found.items).toEqual([
      expect.objectContaining({
        productId: ctx.rx.product.id,
        productName: "Amoxicillin 500 mg Capsule",
        remaining: "20.000",
      }),
    ]);
  });

  test("the list filters by status and by number", async ({ expect }) => {
    const ctx = await setup();
    const one = await record(ctx);

    await record(ctx);
    await verifyPrescription(ctx.pharmacist, one.id, {}, { now: NOW });

    expect((await listPrescriptions(ctx.cashier, {})).total).toBe(2);
    expect((await listPrescriptions(ctx.cashier, { status: "VERIFIED" })).total).toBe(1);
    expect((await listPrescriptions(ctx.cashier, { q: "0002" })).total).toBe(1);
    expect((await listPrescriptions(ctx.cashier, { q: "%" })).total).toBe(0);
  });
});
