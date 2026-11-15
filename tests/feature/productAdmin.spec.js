import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../../database/client.js";
import { HttpError, ValidationError } from "../../app/http/errors.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { productBarcodes } from "../../app/models/product-barcodes.js";
import { productPrices } from "../../app/models/product-prices.js";
import { productUnits } from "../../app/models/product-units.js";
import { products } from "../../app/models/products.js";
import { purchaseOrderItems } from "../../app/models/purchase-order-items.js";
import { purchaseOrders } from "../../app/models/purchase-orders.js";
import { saleItems } from "../../app/models/sale-items.js";
import { suppliers } from "../../app/models/suppliers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { loadEffectivePrices } from "../../app/services/catalog/pricing.js";
import {
  createProduct,
  getProductForEdit,
  listProducts,
  setProductActive,
  updateProduct,
} from "../../app/services/catalog/productAdmin.js";
import { searchProducts } from "../../app/services/catalog/productLookup.js";
import { createSale } from "../../app/services/sales/checkout.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeBranch,
  makeCategory,
  makeManufacturer,
  makeSale,
  makeStock,
  makeUnit,
  makeWorld,
} from "../helpers/factories.js";

const THEN = new Date("2026-11-12T02:00:00Z");
const NOW = new Date("2026-11-12T03:00:00Z");

async function setup() {
  return {
    user: await makeAuthUser({ permissions: ROLE_PERMISSIONS.pharmacist }),
    tablet: await makeUnit("Tablet"),
    strip: await makeUnit("Strip"),
    box: await makeUnit("Box"),
  };
}

const unitRow = (unitId, overrides = {}) => {
  return {
    id: null,
    unitId,
    conversionFactor: "1.000",
    isBaseUnit: false,
    canBeSold: true,
    isActive: true,
    barcodes: [],
    price: "3.5000",
    ...overrides,
  };
};

// A normalized form: a tablet base unit priced 3.50, plus whatever `over` changes.
const form = (ctx, over = {}) => {
  return {
    sku: "SYR-1",
    productName: "Syrup",
    genericName: "Generic syrup",
    brandName: null,
    strength: null,
    dosageForm: null,
    categoryId: null,
    manufacturerId: null,
    description: null,
    prescriptionClassification: "OTC",
    requiresPrescription: false,
    reorderLevel: "0.000",
    isActive: true,
    units: [unitRow(ctx.tablet, { isBaseUnit: true })],
    ...over,
  };
};

async function counts() {
  const [[row]] = await pool.query(`SELECT
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM product_units) AS units,
    (SELECT COUNT(*) FROM product_barcodes) AS barcodes,
    (SELECT COUNT(*) FROM product_prices) AS prices,
    (SELECT COUNT(*) FROM audit_logs) AS audits,
    (SELECT COUNT(*) FROM inventories) AS inventories`);

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      return [key, Number(value)];
    }),
  );
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return null;
}

const pathsOf = (error) => {
  return error.details.map((detail) => {
    return detail.path;
  });
};

test.group("createProduct", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("writes the product, units, barcodes, prices and one audit row, with no stock", async ({
    expect,
  }) => {
    const ctx = await setup();
    const category = await makeCategory();
    const maker = await makeManufacturer();

    const { id } = await createProduct(
      ctx.user,
      form(ctx, {
        categoryId: category.id,
        manufacturerId: maker.id,
        brandName: "Brand",
        reorderLevel: "200.000",
        units: [
          unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["T-1", "T-2"] }),
          unitRow(ctx.strip, { conversionFactor: "10.000", price: "30.0000", barcodes: ["S-1"] }),
          unitRow(ctx.box, { conversionFactor: "100.000", canBeSold: false, price: null }),
        ],
      }),
      { now: THEN },
    );

    const [product] = await db.select().from(products).where(eq(products.id, id));
    const units = await db.select().from(productUnits).where(eq(productUnits.productId, id));
    const prices = await db.select().from(productPrices);
    const barcodes = await db.select().from(productBarcodes);
    const [audit] = await db.select().from(auditLogs);

    expect(product).toMatchObject({
      sku: "SYR-1",
      productName: "Syrup",
      categoryId: category.id,
      manufacturerId: maker.id,
      brandName: "Brand",
      reorderLevel: "200.000",
      isActive: true,
    });
    expect(units).toHaveLength(3);
    expect(
      units.filter((unit) => {
        return unit.isBaseUnit;
      }),
    ).toHaveLength(1);
    expect(
      prices
        .map((price) => {
          return [price.unitPrice, price.branchId, price.effectiveTo];
        })
        .sort(),
    ).toEqual([
      ["3.5000", null, null],
      ["30.0000", null, null],
    ]);
    expect(prices[0].effectiveFrom.getTime()).toBe(THEN.getTime());
    expect(
      barcodes
        .map((row) => {
          return row.barcode;
        })
        .sort(),
    ).toEqual(["S-1", "T-1", "T-2"]);
    expect(audit).toMatchObject({
      action: "PRODUCT_CREATED",
      entityType: "product",
      entityId: id,
      userId: ctx.user.id,
    });
    expect((await counts()).inventories).toBe(0);
  });

  test("a new product sells through checkout at the typed price", async ({ expect }) => {
    const ctx = await setup();
    const world = await makeWorld();
    const { id } = await createProduct(
      ctx.user,
      form(ctx, { units: [unitRow(ctx.tablet, { isBaseUnit: true, price: "3.5" })] }),
      { now: THEN },
    );
    await makeStock({ productId: id, branchId: world.branch.id, batches: [{ quantity: "100" }] });
    const [unit] = await db.select().from(productUnits).where(eq(productUnits.productId, id));

    const result = await createSale(
      await loadAuthUser(world.cashier.id),
      {
        items: [{ productUnitId: unit.id, quantity: "2.000" }],
        payments: [{ method: "CASH", amount: "10.00", reference: null }],
        customerId: null,
      },
      randomUUID(),
      { now: NOW },
    );
    const [item] = await db.select().from(saleItems).where(eq(saleItems.saleId, result.saleId));

    expect(item).toMatchObject({ unitPrice: "3.5000", subtotal: "7.00" });
  });

  test("a duplicate SKU or barcode is a field error and writes nothing (review focus 1, 4)", async ({
    expect,
  }) => {
    const ctx = await setup();
    await createProduct(
      ctx.user,
      form(ctx, { units: [unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["DUP-1"] })] }),
    );
    const before = await counts();

    const sku = await failure(createProduct(ctx.user, form(ctx, { sku: "SYR-1" })));
    const barcode = await failure(
      createProduct(
        ctx.user,
        form(ctx, {
          sku: "OTHER",
          units: [unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["dup-1"] })],
        }),
      ),
    );
    // the clash is on the second unit: the first unit and the product must not survive either
    const second = await failure(
      createProduct(
        ctx.user,
        form(ctx, {
          sku: "THIRD",
          units: [
            unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["FRESH"] }),
            unitRow(ctx.strip, { conversionFactor: "10.000", barcodes: ["DUP-1"] }),
          ],
        }),
      ),
    );

    expect(sku).toBeInstanceOf(ValidationError);
    expect(pathsOf(sku)).toEqual(["sku"]);
    expect(pathsOf(barcode)).toEqual(["units.0.barcodes"]);
    expect(pathsOf(second)).toEqual(["units.1.barcodes"]);
    expect(await counts()).toEqual(before);
  });

  test("two creates with one SKU at once: one product, one field error", async ({ expect }) => {
    const ctx = await setup();

    for (let round = 0; round < 5; round += 1) {
      const sku = `RACE-${round}`;
      const results = await Promise.allSettled([
        createProduct(ctx.user, form(ctx, { sku })),
        createProduct(ctx.user, form(ctx, { sku })),
      ]);
      const rejected = results.filter((result) => {
        return result.status === "rejected";
      });

      expect([sku, rejected]).toHaveLength(2);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ValidationError);
      expect(pathsOf(rejected[0].reason)).toEqual(["sku"]);
      expect(await db.select().from(products).where(eq(products.sku, sku))).toHaveLength(1);
    }
  });

  test("an unknown category, manufacturer or unit is refused", async ({ expect }) => {
    const ctx = await setup();
    const unknown = randomUUID();

    const category = await failure(createProduct(ctx.user, form(ctx, { categoryId: unknown })));
    const maker = await failure(createProduct(ctx.user, form(ctx, { manufacturerId: unknown })));
    const unit = await failure(
      createProduct(ctx.user, form(ctx, { units: [unitRow(unknown, { isBaseUnit: true })] })),
    );

    expect(pathsOf(category)).toEqual(["categoryId"]);
    expect(pathsOf(maker)).toEqual(["manufacturerId"]);
    expect(pathsOf(unit)).toEqual(["units.0.unitId"]);
    expect((await counts()).products).toBe(0);
  });
});

test.group("updateProduct", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  async function twoUnits(ctx) {
    const { id } = await createProduct(
      ctx.user,
      form(ctx, {
        units: [
          unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["T-1"] }),
          unitRow(ctx.strip, { conversionFactor: "10.000", price: "30.0000", barcodes: ["S-1"] }),
        ],
      }),
      { now: THEN },
    );
    const edit = await getProductForEdit(id);

    return { id, edit };
  }

  const asForm = (ctx, edit, over = {}) => {
    return form(ctx, {
      ...edit.product,
      units: edit.product.units.map((unit) => {
        return unitRow(unit.unitId, {
          id: unit.id,
          conversionFactor: unit.conversionFactor,
          isBaseUnit: unit.isBaseUnit,
          canBeSold: unit.canBeSold,
          isActive: unit.isActive,
          barcodes: unit.barcodes,
          price: unit.price,
        });
      }),
      ...over,
    });
  };

  test("without history everything is editable, and one audit row keeps old and new values", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id, edit } = await twoUnits(ctx);
    const [tablet, strip] = edit.product.units;

    await updateProduct(
      ctx.user,
      id,
      asForm(ctx, edit, {
        productName: "Syrup forte",
        prescriptionClassification: "PRESCRIPTION",
        requiresPrescription: true,
        units: [
          unitRow(ctx.tablet, { id: tablet.id, isBaseUnit: true, barcodes: ["T-1", "S-1"] }),
          unitRow(ctx.box, { conversionFactor: "100.000", price: "250.0000" }),
        ],
      }),
      { now: NOW },
    );

    const after = await getProductForEdit(id);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "PRODUCT_UPDATED"));

    expect(after.product).toMatchObject({ productName: "Syrup forte", requiresPrescription: true });
    expect(
      after.product.units.map((unit) => {
        return [unit.unitId, unit.conversionFactor];
      }),
    ).toEqual([
      [ctx.tablet, "1.000"],
      [ctx.box, "100.000"],
    ]);
    expect(
      after.product.units
        .find((unit) => {
          return unit.unitId === ctx.tablet;
        })
        .barcodes.sort(),
    ).toEqual(["S-1", "T-1"]);
    expect(await db.select().from(productUnits).where(eq(productUnits.id, strip.id))).toHaveLength(
      0,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValues.productName).toBe("Syrup");
    expect(audits[0].newValues.productName).toBe("Syrup forte");
  });

  test("a product with batches keeps its units, factors and base flag (review focus 2)", async ({
    expect,
  }) => {
    const ctx = await setup();
    const world = await makeWorld();
    const { id, edit } = await twoUnits(ctx);
    await makeStock({ productId: id, branchId: world.branch.id, batches: [{ quantity: "50" }] });
    const [tablet, strip] = edit.product.units;
    const before = await counts();
    const change = (units) => {
      return failure(updateProduct(ctx.user, id, asForm(ctx, edit, { units }), { now: NOW }));
    };
    const keep = (unit) => {
      return unitRow(unit.unitId, {
        id: unit.id,
        conversionFactor: unit.conversionFactor,
        isBaseUnit: unit.isBaseUnit,
        price: unit.price,
      });
    };

    const factor = await change([keep(tablet), { ...keep(strip), conversionFactor: "12.000" }]);
    const swapped = await change([keep(tablet), { ...keep(strip), unitId: ctx.box }]);
    const base = await change([
      { ...keep(tablet), isBaseUnit: false },
      { ...keep(strip), isBaseUnit: true, conversionFactor: "1.000" },
    ]);
    const removed = await change([keep(tablet)]);
    const newBase = await change([
      keep(tablet),
      keep(strip),
      unitRow(ctx.box, { conversionFactor: "1.000", isBaseUnit: true }),
    ]);

    expect(pathsOf(factor)).toEqual(["units.1.conversionFactor"]);
    expect(pathsOf(swapped)).toEqual(["units.1.unitId"]);
    expect(pathsOf(base).sort()).toEqual(
      ["units.0.isBaseUnit", "units.1.conversionFactor", "units.1.isBaseUnit"].sort(),
    );
    expect(pathsOf(removed)).toEqual(["units"]);
    expect(newBase).toBeInstanceOf(ValidationError);
    expect(await counts()).toEqual(before);

    // what stays editable
    await updateProduct(
      ctx.user,
      id,
      asForm(ctx, edit, {
        productName: "Renamed",
        reorderLevel: "5.000",
        units: [
          { ...keep(tablet), barcodes: ["NEW-1"], isActive: false },
          { ...keep(strip), price: "31.0000" },
          unitRow(ctx.box, { conversionFactor: "100.000", price: "250.0000" }),
        ],
      }),
      { now: NOW },
    );

    const after = await getProductForEdit(id);

    expect(after.product.productName).toBe("Renamed");
    expect(after.product.units).toHaveLength(3);
    expect(after.hasHistory).toBe(true);
  });

  test("a product that only appears on a purchase order is locked too", async ({ expect }) => {
    const ctx = await setup();
    const { id, edit } = await twoUnits(ctx);
    const branch = await makeBranch();
    const supplierId = randomUUID();
    const orderId = randomUUID();

    await db.insert(suppliers).values({ id: supplierId, code: "SUP-PO", name: "Supplier" });
    await db.insert(purchaseOrders).values({
      id: orderId,
      poNumber: "PO-LOCK-1",
      branchId: branch.id,
      supplierId,
      status: "SENT",
      createdBy: ctx.user.id,
    });
    await db.insert(purchaseOrderItems).values({
      purchaseOrderId: orderId,
      productId: id,
      productUnitId: edit.product.units[1].id,
      conversionFactor: "10.000",
      quantityOrdered: "10",
      unitCost: "30.0000",
      lineTotal: "300.00",
    });

    // changing what a Strip is while an order for strips is open would change what it brings in
    const error = await failure(
      updateProduct(
        ctx.user,
        id,
        asForm(ctx, edit, {
          units: asForm(ctx, edit).units.map((unit, index) => {
            return index === 1 ? { ...unit, conversionFactor: "5.000" } : unit;
          }),
        }),
      ),
    );

    expect((await getProductForEdit(id)).hasHistory).toBe(true);
    expect(error).toBeInstanceOf(ValidationError);
  });

  test("a product that only appears on a sale item is locked too", async ({ expect }) => {
    const ctx = await setup();
    const world = await makeWorld();
    const { id, edit } = await twoUnits(ctx);
    await makeSale({
      branchId: world.branch.id,
      cashierId: world.cashier.id,
      sessionId: world.session.id,
      lines: [
        { productId: id, productUnitId: edit.product.units[0].id, quantity: "1", batches: [] },
      ],
      payments: [{ method: "CASH", amount: "10.00" }],
    });

    const error = await failure(
      updateProduct(
        ctx.user,
        id,
        asForm(ctx, edit, {
          units: [{ ...asForm(ctx, edit).units[0], conversionFactor: "1.000", unitId: ctx.box }],
        }),
      ),
    );

    expect((await getProductForEdit(id)).hasHistory).toBe(true);
    expect(error).toBeInstanceOf(ValidationError);
  });

  test("a price change closes the old row and opens a new one without touching history (review focus 5)", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id, edit } = await twoUnits(ctx);
    const tablet = edit.product.units[0];

    await updateProduct(ctx.user, id, asForm(ctx, edit), { now: NOW });
    const unchanged = await db.select().from(productPrices);
    await updateProduct(
      ctx.user,
      id,
      asForm(ctx, edit, {
        units: [{ ...asForm(ctx, edit).units[0], price: "4.0000" }, asForm(ctx, edit).units[1]],
      }),
      { now: NOW },
    );

    const rows = await db
      .select()
      .from(productPrices)
      .where(eq(productPrices.productUnitId, tablet.id));
    const closed = rows.find((row) => {
      return row.effectiveTo !== null;
    });
    const open = rows.find((row) => {
      return row.effectiveTo === null;
    });

    expect(unchanged).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(closed).toMatchObject({ unitPrice: "3.5000" });
    expect(closed.effectiveTo.getTime()).toBe(NOW.getTime());
    expect(open).toMatchObject({ unitPrice: "4.0000" });
    expect(open.effectiveFrom.getTime()).toBe(NOW.getTime());
    expect(
      (await loadEffectivePrices(db, [tablet.id], null, new Date(NOW.getTime() - 1000))).get(
        tablet.id,
      ),
    ).toBe("3.5000");
    expect((await loadEffectivePrices(db, [tablet.id], null, NOW)).get(tablet.id)).toBe("4.0000");
  });

  test("an unknown or malformed id is a 404", async ({ expect }) => {
    const ctx = await setup();

    for (const id of [randomUUID(), "not-a-uuid", "é"]) {
      const error = await failure(updateProduct(ctx.user, id, form(ctx)));

      expect([id, error instanceof HttpError, error?.status]).toEqual([id, true, 404]);
    }
  });
});

test.group("setProductActive and the rest of the system", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("deactivating hides the product from lookup and checkout; activating restores it", async ({
    expect,
  }) => {
    const ctx = await setup();
    const world = await makeWorld();
    const { id } = await createProduct(ctx.user, form(ctx), { now: THEN });
    await makeStock({ productId: id, branchId: world.branch.id, batches: [{ quantity: "10" }] });
    const [unit] = await db.select().from(productUnits).where(eq(productUnits.productId, id));
    const cashier = await loadAuthUser(world.cashier.id);
    const sell = () => {
      return createSale(
        cashier,
        {
          items: [{ productUnitId: unit.id, quantity: "1.000" }],
          payments: [{ method: "CASH", amount: "10.00", reference: null }],
          customerId: null,
        },
        randomUUID(),
        { now: NOW },
      );
    };

    expect(await setProductActive(ctx.user, id, false, { now: NOW })).toEqual({
      id,
      changed: true,
    });
    expect(await searchProducts({ q: "Syrup", branchId: world.branch.id })).toEqual([]);
    expect(pathsOf(await failure(sell()))).toEqual(["items.0.productUnitId"]);

    expect(await setProductActive(ctx.user, id, true, { now: NOW })).toEqual({ id, changed: true });
    expect(await searchProducts({ q: "Syrup", branchId: world.branch.id })).toHaveLength(1);
    expect((await sell()).replayed).toBe(false);
  });

  test("repeating a status writes nothing; an unknown id is a 404", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await createProduct(ctx.user, form(ctx));
    const before = await counts();

    expect(await setProductActive(ctx.user, id, true)).toEqual({ id, changed: false });
    expect(await counts()).toEqual(before);

    await setProductActive(ctx.user, id, false);
    const actions = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "PRODUCT_DEACTIVATED")));

    expect(actions).toHaveLength(1);
    expect((await failure(setProductActive(ctx.user, randomUUID(), true))).status).toBe(404);
  });
});

test.group("listProducts and getProductForEdit", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  async function catalog(ctx) {
    const cough = await makeCategory({ name: "Cough" });
    const pain = await makeCategory({ name: "Pain" });
    const make = (sku, productName, over = {}) => {
      return createProduct(ctx.user, form(ctx, { sku, productName, ...over }));
    };

    await make("A-1", "Alpha syrup", { categoryId: cough.id, genericName: "Dextro" });
    await make("B-2", "Bravo tablet", { categoryId: pain.id, brandName: "Painex" });
    await make("C-3", "Charlie 100% natural", { categoryId: pain.id });
    await make("D-4", "Delta", { isActive: false });

    return { cough, pain };
  }

  test("filters by text, status and category, in name order, with a total", async ({ expect }) => {
    const ctx = await setup();
    const { cough, pain } = await catalog(ctx);
    const names = async (filters) => {
      return (await listProducts(filters)).rows.map((row) => {
        return row.productName;
      });
    };

    expect(await names({})).toEqual(["Alpha syrup", "Bravo tablet", "Charlie 100% natural"]);
    expect(await names({ status: "inactive" })).toEqual(["Delta"]);
    expect((await names({ status: "any" })).length).toBe(4);
    expect(await names({ q: "PAINEX" })).toEqual(["Bravo tablet"]);
    expect(await names({ q: "dextro" })).toEqual(["Alpha syrup"]);
    expect(await names({ q: "b-2" })).toEqual(["Bravo tablet"]);
    expect(await names({ categoryId: pain.id })).toEqual(["Bravo tablet", "Charlie 100% natural"]);
    expect(await names({ categoryId: cough.id, q: "alpha" })).toEqual(["Alpha syrup"]);
    expect(await names({ categoryId: "not-a-uuid" })).toEqual([]);

    const page = await listProducts({ perPage: 2, page: 2 });

    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      sku: "C-3",
      categoryName: "Pain",
      baseUnitName: "Tablet",
      prescriptionClassification: "OTC",
    });
  });

  test("LIKE wildcards in a search match only themselves", async ({ expect }) => {
    const ctx = await setup();
    await catalog(ctx);
    const total = async (q) => {
      return (await listProducts({ q, status: "any" })).total;
    };

    expect(await total("%")).toBe(1);
    expect(await total("100%")).toBe(1);
    expect(await total("_")).toBe(0);
    expect(await total("\\")).toBe(0);
  });

  test("getProductForEdit returns the form values, or null for a missing or malformed id", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await createProduct(
      ctx.user,
      form(ctx, { units: [unitRow(ctx.tablet, { isBaseUnit: true, barcodes: ["T-1"] })] }),
    );
    const edit = await getProductForEdit(id);

    expect(edit.hasHistory).toBe(false);
    expect(edit.product).toMatchObject({ id, sku: "SYR-1", reorderLevel: "0.000" });
    expect(edit.product.units[0]).toMatchObject({
      unitId: ctx.tablet,
      unitName: "Tablet",
      conversionFactor: "1.000",
      isBaseUnit: true,
      barcodes: ["T-1"],
      price: "3.5000",
    });
    expect(await getProductForEdit(randomUUID())).toBeNull();
    expect(await getProductForEdit("not-a-uuid")).toBeNull();
    expect(await getProductForEdit("é")).toBeNull();
  });
});
