import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import {
  getStockOverview,
  listBatches,
  resolveBranch,
} from "../../app/services/inventory/stockOverview.js";
import { resetDatabase } from "../helpers/db.js";
import { makeAuthUser, makeBranch, makeProduct } from "../helpers/factories.js";

const NOW = new Date("2026-11-12T03:00:00Z"); // business date 2026-11-12 in Asia/Manila

const day = (offset) => {
  return new Date(Date.parse("2026-11-12T00:00:00Z") + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
};

async function world() {
  const main = await makeBranch({ code: "MAIN" });
  const north = await makeBranch({ code: "NORTH" });
  const pharmacist = await makeAuthUser({
    branchId: main.id,
    roleName: "pharmacist-stock",
    permissions: ROLE_PERMISSIONS.pharmacist,
  });
  const accountant = await makeAuthUser({
    branchId: main.id,
    roleName: "accountant-stock",
    permissions: ROLE_PERMISSIONS.accountant,
  });

  await makeProduct({
    branchId: main.id,
    name: "Alpha",
    sku: "A-1",
    reorderLevel: "100",
    batches: [
      { quantity: "60", batchNumber: "A-OK", expirationDate: day(300) },
      { quantity: "50", batchNumber: "A-SOON", expirationDate: day(10) },
      { quantity: "40", batchNumber: "A-QUAR", expirationDate: day(300), status: "QUARANTINED" },
      { quantity: "30", batchNumber: "A-RECALL", expirationDate: day(300), status: "RECALLED" },
      { quantity: "20", batchNumber: "A-OLD", expirationDate: day(-1) },
      { quantity: "5", batchNumber: "A-GONE", expirationDate: day(-30), status: "EXPIRED" },
      { quantity: "15", batchNumber: "A-NOEXP", expirationDate: null },
    ],
  });
  await makeProduct({
    branchId: main.id,
    name: "Bravo",
    sku: "B-2",
    reorderLevel: "500",
    batches: [{ quantity: "100", batchNumber: "B-OK", expirationDate: day(200) }],
  });
  await makeProduct({
    branchId: north.id,
    name: "Charlie",
    sku: "C-3",
    batches: [{ quantity: "70", batchNumber: "C-OK", expirationDate: day(100) }],
  });

  return { main, north, pharmacist, accountant };
}

const byName = (rows) => {
  return Object.fromEntries(
    rows.map((row) => {
      return [row.productName, row];
    }),
  );
};

test.group("getStockOverview", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("on hand is what is recorded, sellable only what may be sold today", async ({ expect }) => {
    const ctx = await world();

    const { rows, branchId } = await getStockOverview({ user: ctx.pharmacist, now: NOW });
    const alpha = byName(rows).Alpha;

    expect(branchId).toBe(ctx.main.id);
    expect(
      rows.map((row) => {
        return row.productName;
      }),
    ).toEqual(["Alpha", "Bravo"]);
    // 60 + 50 + 15 sellable; quarantined, recalled, expired and EXPIRED-status stock is not
    expect(alpha).toMatchObject({
      sku: "A-1",
      baseUnitName: "Tablet",
      onHand: "220.000",
      sellable: "125.000",
      reorderLevel: "100.000",
      low: false,
      expiringSoon: true,
      expiredStock: true,
    });
    expect(byName(rows).Bravo).toMatchObject({
      sellable: "100.000",
      low: true,
      expiringSoon: false,
      expiredStock: false,
    });
  });

  test("EXPIRY_BUFFER_DAYS lowers what is sellable", async ({ expect }) => {
    const ctx = await world();
    const original = process.env.EXPIRY_BUFFER_DAYS;
    process.env.EXPIRY_BUFFER_DAYS = "11";

    try {
      const { rows } = await getStockOverview({ user: ctx.pharmacist, now: NOW });

      expect(byName(rows).Alpha.sellable).toBe("75.000");
    } finally {
      if (original === undefined) {
        delete process.env.EXPIRY_BUFFER_DAYS;
      } else {
        process.env.EXPIRY_BUFFER_DAYS = original;
      }
    }
  });

  test("flag and text filters", async ({ expect }) => {
    const ctx = await world();
    const names = async (filters) => {
      return (await getStockOverview({ user: ctx.pharmacist, now: NOW, ...filters })).rows.map(
        (row) => {
          return row.productName;
        },
      );
    };

    expect(await names({ flag: "low" })).toEqual(["Bravo"]);
    expect(await names({ flag: "expiring" })).toEqual(["Alpha"]);
    expect(await names({ flag: "expired" })).toEqual(["Alpha"]);
    expect(await names({ q: "b-2" })).toEqual(["Bravo"]);
    expect(await names({ q: "%" })).toEqual([]);
  });

  test("a branch is seen by its own staff, or by a user with the all-branch scope (review focus 3)", async ({
    expect,
  }) => {
    const ctx = await world();

    const north = await getStockOverview({
      user: ctx.accountant,
      branchId: ctx.north.id,
      now: NOW,
    });
    const refused = await getStockOverview({
      user: ctx.pharmacist,
      branchId: ctx.north.id,
      now: NOW,
    }).catch((error) => {
      return error;
    });

    expect(
      north.rows.map((row) => {
        return row.productName;
      }),
    ).toEqual(["Charlie"]);
    expect([refused.status, refused.code]).toEqual([403, "forbidden"]);
    expect(resolveBranch(ctx.pharmacist, ctx.main.id)).toBe(ctx.main.id);
    expect(() => resolveBranch(ctx.pharmacist, "not-a-uuid")).toThrow();
    expect(() => resolveBranch({ ...ctx.pharmacist, branchId: null })).toThrow();
  });
});

test.group("listBatches", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  const numbers = (result) => {
    return result.rows.map((row) => {
      return row.batchNumber;
    });
  };

  test("lists the branch's batches soonest expiry first, undated last", async ({ expect }) => {
    const ctx = await world();

    const result = await listBatches({ user: ctx.pharmacist, now: NOW });

    expect(result.total).toBe(8);
    expect(numbers(result)).toEqual([
      "A-GONE",
      "A-OLD",
      "A-SOON",
      "B-OK",
      "A-OK",
      "A-QUAR",
      "A-RECALL",
      "A-NOEXP",
    ]);
    expect(result.rows[1]).toMatchObject({
      productName: "Alpha",
      sku: "A-1",
      expirationDate: day(-1),
      quantityAvailable: "20.000",
      status: "ACTIVE",
    });
    expect(result.rows.at(-1).expirationDate).toBeNull();
  });

  test("filters by status, expiry window, text and pages", async ({ expect }) => {
    const ctx = await world();
    const run = async (filters) => {
      return listBatches({ user: ctx.pharmacist, now: NOW, ...filters });
    };

    expect(numbers(await run({ status: "QUARANTINED" }))).toEqual(["A-QUAR"]);
    expect(numbers(await run({ expiry: "expired" }))).toEqual(["A-GONE", "A-OLD"]);
    expect(numbers(await run({ expiry: "30" }))).toEqual(["A-SOON"]);
    expect(numbers(await run({ expiry: "90" }))).toEqual(["A-SOON"]);
    expect(numbers(await run({ q: "b-ok" }))).toEqual(["B-OK"]);
    expect(numbers(await run({ q: "bravo" }))).toEqual(["B-OK"]);
    expect(numbers(await run({ q: "_" }))).toEqual([]);

    const page = await run({ perPage: 3, page: 3 });

    expect(page.total).toBe(8);
    expect(numbers(page)).toEqual(["A-RECALL", "A-NOEXP"]);
  });

  test("another branch's batches are not listed, and the all-branch scope can ask for them", async ({
    expect,
  }) => {
    const ctx = await world();

    const own = await listBatches({ user: ctx.pharmacist, now: NOW });
    const north = await listBatches({ user: ctx.accountant, branchId: ctx.north.id, now: NOW });

    expect(numbers(own)).not.toContain("C-OK");
    expect(numbers(north)).toEqual(["C-OK"]);
  });
});
