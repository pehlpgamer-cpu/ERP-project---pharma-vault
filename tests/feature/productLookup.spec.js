import { test } from "@japa/runner";
import { db } from "../../database/client.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadEffectivePrices } from "../../app/services/catalog/pricing.js";
import { searchProducts } from "../../app/services/catalog/productLookup.js";
import { addDays, businessDate } from "../../app/services/support/time.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makePrice,
  makeProduct,
  makeStock,
  makeUser,
  makeWorld,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const TABLET = { name: "Tablet", factor: "1", base: true, price: "10.0000" };

const namesOf = (items) => {
  return items.map((item) => {
    return item.name;
  });
};

async function search(q, branch, extra = {}) {
  return searchProducts({ q, branchId: branch.id, ...extra });
}

test.group("product lookup: matching", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("an exact barcode returns that product first with the scanned unit preselected", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const scanned = await makeProduct({
      name: "Zeta Syrup",
      units: [
        { name: "Bottle", factor: "1", base: true, price: "80.0000", barcodes: ["4801234567890"] },
        { name: "Box", factor: "12", price: "900.0000", barcodes: ["4801234567999"] },
      ],
    });
    await makeProduct({ name: "Alpha 4801234567890 sample", units: [TABLET] });

    const results = await search("4801234567999", branch);
    const both = await search("4801234567890", branch);
    const prefix = await search("4801234567", branch);

    expect(namesOf(results)).toEqual(["Zeta Syrup"]);
    expect(results[0].matchedUnitId).toBe(scanned.units[1].id);
    expect(namesOf(both)).toEqual(["Zeta Syrup", "Alpha 4801234567890 sample"]);
    expect(both[0].matchedUnitId).toBe(scanned.units[0].id);
    expect(both[1].matchedUnitId).toBeNull();
    // a barcode must match exactly: a prefix finds the product by name only, never by barcode
    expect(namesOf(prefix)).toEqual(["Alpha 4801234567890 sample"]);
  });

  test("name, generic name, brand name and SKU match by contains, ignoring case", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    await makeProduct({ name: "Paracetamol 500 mg Tablet", genericName: "G1", sku: "SKU-A1" });
    await makeProduct({ name: "Pain Reliever", genericName: "Acetaminophen", sku: "SKU-B2" });
    await makeProduct({
      name: "Fever Syrup",
      genericName: "G3",
      brandName: "Biogesic",
      sku: "SKU-C3",
    });
    await makeProduct({ name: "Cough Drops", genericName: "G4", sku: "XYZ-777" });

    expect(namesOf(await search("PARAC", branch))).toEqual(["Paracetamol 500 mg Tablet"]);
    expect(namesOf(await search("acetamino", branch))).toEqual(["Pain Reliever"]);
    expect(namesOf(await search("biogES", branch))).toEqual(["Fever Syrup"]);
    expect(namesOf(await search("xyz-7", branch))).toEqual(["Cough Drops"]);
    expect(await search("nothing like this", branch)).toEqual([]);
  });

  test("results are ordered by product name", async ({ expect }) => {
    const branch = await makeBranch();
    await makeProduct({ name: "Item C" });
    await makeProduct({ name: "Item A" });
    await makeProduct({ name: "Item B" });

    expect(namesOf(await search("item", branch))).toEqual(["Item A", "Item B", "Item C"]);
  });

  test("a search of only wildcard characters matches nothing (review focus 1)", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    await makeProduct({ name: "Vitamin C 500 mg" });
    await makeProduct({ name: "Cough Syrup" });

    for (const q of ["%", "_", "\\", "%%", "_%"]) {
      expect([q, await search(q, branch)]).toEqual([q, []]);
    }
  });

  test("wildcard characters inside a search match only themselves (review focus 1)", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    await makeProduct({ name: "Vitamin C 100% Natural" });
    await makeProduct({ name: "Vitamin C 1000 mg" });
    await makeProduct({ name: "Sample_Item" });
    await makeProduct({ name: "SampleXItem" });
    await makeProduct({ name: "Back\\Slash" });
    await makeProduct({ name: "BackSlash" });

    expect(namesOf(await search("100%", branch))).toEqual(["Vitamin C 100% Natural"]);
    expect(namesOf(await search("e_I", branch))).toEqual(["Sample_Item"]);
    expect(namesOf(await search("k\\S", branch))).toEqual(["Back\\Slash"]);
  });

  test("limit caps the results", async ({ expect }) => {
    const branch = await makeBranch();

    for (const letter of ["A", "B", "C", "D", "E"]) {
      await makeProduct({ name: `Item ${letter}` });
    }

    expect(await search("item", branch)).toHaveLength(5);
    expect(namesOf(await search("item", branch, { limit: 2 }))).toEqual(["Item A", "Item B"]);
  });

  test("hides inactive products, products without a sellable unit and unsellable units", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    await makeProduct({ name: "Item inactive", isActive: false, units: [TABLET] });
    await makeProduct({
      name: "Item not sold",
      units: [{ name: "Tablet", factor: "1", base: true, price: "10.0000", canBeSold: false }],
    });
    await makeProduct({
      name: "Item retired unit",
      units: [{ name: "Tablet", factor: "1", base: true, price: "10.0000", isActive: false }],
    });
    await makeProduct({ name: "Item without units", units: [] });
    await makeProduct({
      name: "Item mixed",
      units: [
        TABLET,
        { name: "Strip", factor: "10", price: "90.0000", isActive: false },
        { name: "Box", factor: "100", price: "800.0000", canBeSold: false },
      ],
    });
    await makeProduct({
      name: "Item scanned",
      isActive: false,
      units: [{ name: "Tablet", factor: "1", base: true, price: "10.0000", barcodes: ["1234567"] }],
    });

    const results = await search("item", branch);

    expect(namesOf(results)).toEqual(["Item mixed"]);
    expect(
      results[0].units.map((unit) => {
        return unit.name;
      }),
    ).toEqual(["Tablet"]);
    expect(await search("1234567", branch)).toEqual([]);
  });
});

test.group("product lookup: units, prices and stock", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("lists sellable units from the smallest to the largest with their barcodes", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    await makeProduct({
      name: "Item units",
      units: [
        { name: "Box", factor: "100", price: "800.0000", barcodes: ["BOX-1"] },
        { name: "Strip", factor: "10", price: "90.0000" },
        { name: "Tablet", factor: "1", base: true, price: "10.0000", barcodes: ["TAB-2", "TAB-1"] },
      ],
    });

    const [item] = await search("item units", branch);

    expect(
      item.units.map((unit) => {
        return [unit.name, unit.conversionFactor, unit.price, unit.barcodes];
      }),
    ).toEqual([
      ["Tablet", "1.000", "10.0000", ["TAB-1", "TAB-2"]],
      ["Strip", "10.000", "90.0000", []],
      ["Box", "100.000", "800.0000", ["BOX-1"]],
    ]);
  });

  test("a unit without an effective price comes back with price null", async ({ expect }) => {
    const branch = await makeBranch();
    const { units } = await makeProduct({
      name: "Item prices",
      units: [
        { name: "Tablet", factor: "1", base: true },
        { name: "Strip", factor: "10" },
      ],
    });
    await makePrice({
      productUnitId: units[1].id,
      unitPrice: "90.0000",
      effectiveFrom: new Date("2099-01-01T00:00:00Z"),
    });

    const [item] = await search("item prices", branch);

    expect(
      item.units.map((unit) => {
        return unit.price;
      }),
    ).toEqual([null, null]);
  });

  test("prices follow the user's branch", async ({ expect }) => {
    const main = await makeBranch();
    const north = await makeBranch();
    const { units } = await makeProduct({ name: "Item branch price", units: [TABLET] });
    await makePrice({ productUnitId: units[0].id, branchId: north.id, unitPrice: "12.5000" });

    const [forMain] = await search("item branch price", main);
    const [forNorth] = await search("item branch price", north);

    expect(forMain.units[0].price).toBe("10.0000");
    expect(forNorth.units[0].price).toBe("12.5000");
  });

  test("availableBaseQuantity counts only sellable batches of the user's branch", async ({
    expect,
  }) => {
    const main = await makeBranch();
    const north = await makeBranch();
    const today = businessDate(new Date());
    const stocked = await makeProduct({
      branchId: main.id,
      name: "Item stocked",
      units: [TABLET],
      batches: [
        { quantity: "100", expirationDate: "2030-01-31" },
        { quantity: "50", expirationDate: null },
        { quantity: "40", expirationDate: addDays(today, -1) },
        { quantity: "30", status: "QUARANTINED" },
        { quantity: "20", status: "RECALLED" },
        { quantity: "10", status: "DEPLETED" },
      ],
    });
    await makeStock({
      productId: stocked.product.id,
      branchId: north.id,
      batches: [{ quantity: "999", expirationDate: "2030-01-31" }],
    });
    await makeProduct({ name: "Item empty", units: [TABLET] });

    const [forMain] = await search("item stocked", main);
    const [forNorth] = await search("item stocked", north);
    const [empty] = await search("item empty", main);

    expect(forMain.availableBaseQuantity).toBe("150.000");
    expect(forNorth.availableBaseQuantity).toBe("999.000");
    expect(empty.availableBaseQuantity).toBe("0.000");
  });

  test("a batch expiring today sells, and EXPIRY_BUFFER_DAYS makes the rule stricter", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const today = businessDate(new Date());
    await makeProduct({
      branchId: branch.id,
      name: "Item edge",
      units: [TABLET],
      batches: [{ quantity: "10", expirationDate: today }],
    });
    const original = process.env.EXPIRY_BUFFER_DAYS;

    try {
      delete process.env.EXPIRY_BUFFER_DAYS;
      expect((await search("item edge", branch))[0].availableBaseQuantity).toBe("10.000");

      process.env.EXPIRY_BUFFER_DAYS = "1";
      expect((await search("item edge", branch))[0].availableBaseQuantity).toBe("0.000");
    } finally {
      if (original === undefined) {
        delete process.env.EXPIRY_BUFFER_DAYS;
      } else {
        process.env.EXPIRY_BUFFER_DAYS = original;
      }
    }
  });

  test("a user without a branch sees global prices and no stock", async ({ expect }) => {
    const branch = await makeBranch();
    await makeProduct({
      branchId: branch.id,
      name: "Item nobranch",
      units: [TABLET],
      batches: [{ quantity: "10" }],
    });

    const [item] = await searchProducts({ q: "item nobranch", branchId: null });

    expect(item.units[0].price).toBe("10.0000");
    expect(item.availableBaseQuantity).toBe("0.000");
  });
});

test.group("loadEffectivePrices", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("returns a price per unit that has one and omits the rest", async ({ expect }) => {
    const main = await makeBranch();
    const north = await makeBranch();
    const { units } = await makeProduct({
      units: [TABLET, { name: "Strip", factor: "10" }],
    });
    await makePrice({ productUnitId: units[0].id, branchId: north.id, unitPrice: "12.5000" });
    await makePrice({
      productUnitId: units[0].id,
      branchId: north.id,
      unitPrice: "99.0000",
      effectiveFrom: new Date("2099-01-01T00:00:00Z"),
    });
    const ids = units.map((unit) => {
      return unit.id;
    });
    const now = new Date();

    const forMain = await loadEffectivePrices(db, ids, main.id, now);
    const forNorth = await loadEffectivePrices(db, ids, north.id, now);

    expect(forMain).toEqual(new Map([[units[0].id, "10.0000"]]));
    expect(forNorth).toEqual(new Map([[units[0].id, "12.5000"]]));
    expect(await loadEffectivePrices(db, [], main.id, now)).toEqual(new Map());
  });
});

test.group("product lookup API", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("returns the documented JSON shape and nothing else", async ({ expect }) => {
    const world = await makeWorld();
    await makeProduct({
      branchId: world.branch.id,
      name: "Amoxicillin 500 mg Capsule",
      genericName: "Amoxicillin",
      brandName: "Amoxil",
      strength: "500 mg",
      dosageForm: "Capsule",
      classification: "PRESCRIPTION",
      requiresPrescription: true,
      units: [{ name: "Capsule", factor: "1", base: true, price: "8.0000", barcodes: ["9990001"] }],
      batches: [{ quantity: "40" }],
    });
    const session = await loginAs(world.cashier);

    const response = await session.get("/api/v1/products?q=amoxi");
    const [item] = response.json().data;

    expect(response.status).toBe(200);
    expect(Object.keys(item).sort()).toEqual([
      "availableBaseQuantity",
      "classification",
      "dosageForm",
      "genericName",
      "id",
      "matchedUnitId",
      "name",
      "requiresPrescription",
      "sku",
      "strength",
      "units",
    ]);
    expect(item).toMatchObject({
      name: "Amoxicillin 500 mg Capsule",
      genericName: "Amoxicillin",
      strength: "500 mg",
      dosageForm: "Capsule",
      classification: "PRESCRIPTION",
      requiresPrescription: true,
      availableBaseQuantity: "40.000",
      matchedUnitId: null,
    });
    expect(item.units).toEqual([
      {
        productUnitId: expect.any(String),
        name: "Capsule",
        abbreviation: "capsule",
        conversionFactor: "1.000",
        price: "8.0000",
        barcodes: ["9990001"],
      },
    ]);
  });

  test("a barcode scan preselects the unit over HTTP", async ({ expect }) => {
    const world = await makeWorld();
    const scanned = await makeProduct({
      name: "Scan me",
      units: [{ name: "Bottle", factor: "1", base: true, price: "5.0000", barcodes: ["7770001"] }],
    });
    const session = await loginAs(world.cashier);

    const response = await session.get("/api/v1/products?q=7770001");

    expect(response.json().data[0].matchedUnitId).toBe(scanned.units[0].id);
  });

  test("q is required and limit must be 1 to 50 (422 envelope)", async ({ expect }) => {
    const session = await loginAs((await makeWorld()).cashier);

    for (const query of [
      "",
      "?q=",
      "?q=%20%20",
      `?q=${"x".repeat(101)}`,
      "?q=a&q=b",
      "?q=a&limit=0",
      "?q=a&limit=51",
      "?q=a&limit=abc",
      "?q=a&limit=2.5",
    ]) {
      const response = await session.get(`/api/v1/products${query}`);

      expect([query, response.status, response.json().error.code]).toEqual([
        query,
        422,
        "validation_failed",
      ]);
    }
  });

  test("q of 100 characters and limit of 50 are accepted", async ({ expect }) => {
    const session = await loginAs((await makeWorld()).cashier);

    const response = await session.get(`/api/v1/products?q=${"x".repeat(100)}&limit=50`);

    expect(response.status).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  test("an accountant is 403 and a signed-out request is 401", async ({ expect }) => {
    const world = await makeWorld();
    const accountant = await loginAs(
      await makeUser({
        branchId: world.branch.id,
        roleName: "accountant-products",
        permissions: ROLE_PERMISSIONS.accountant,
      }),
    );

    const denied = await accountant.get("/api/v1/products?q=para");
    const anonymous = await new TestSession().get("/api/v1/products?q=para");

    expect([denied.status, denied.json().error.code]).toEqual([403, "forbidden"]);
    expect([anonymous.status, anonymous.json().error.code]).toEqual([401, "unauthenticated"]);
  });
});
