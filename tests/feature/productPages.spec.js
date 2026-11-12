import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db, pool } from "../../database/client.js";
import { products } from "../../app/models/products.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { createProduct } from "../../app/services/catalog/productAdmin.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeBranch,
  makeCategory,
  makeManufacturer,
  makeStock,
  makeUnit,
  makeUser,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";
const SCRIPT = new URL("../../public/js/product-form.js", import.meta.url);

async function setup() {
  const pharmacist = await makeUser({
    roleName: "pharmacist-products",
    permissions: ROLE_PERMISSIONS.pharmacist,
  });

  return {
    http: await loginAs(pharmacist),
    actor: await makeAuthUser({ permissions: ROLE_PERMISSIONS.pharmacist }),
    tablet: await makeUnit("Tablet"),
    strip: await makeUnit("Strip"),
  };
}

// A form post as a browser sends it: flat keys such as units[0][unitId].
const post = (ctx, over = {}) => {
  return {
    sku: "SYR-1",
    productName: "Syrup",
    genericName: "Generic syrup",
    prescriptionClassification: "OTC",
    reorderLevel: "0",
    isActive: "on",
    "units[0][unitId]": ctx.tablet,
    "units[0][conversionFactor]": "1",
    "units[0][isBaseUnit]": "on",
    "units[0][canBeSold]": "on",
    "units[0][isActive]": "on",
    "units[0][barcodes]": "",
    "units[0][price]": "3.5",
    ...over,
  };
};

const unitInput = (unitId, over = {}) => {
  return {
    id: null,
    unitId,
    conversionFactor: "1.000",
    isBaseUnit: true,
    canBeSold: true,
    isActive: true,
    barcodes: [],
    price: "3.5000",
    ...over,
  };
};

const normalized = (ctx, over = {}) => {
  return {
    sku: "SKU-0",
    productName: "Product",
    genericName: "Generic",
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
    units: [unitInput(ctx.tablet)],
    ...over,
  };
};

async function productCount() {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM products");

  return Number(row.n);
}

test.group("product pages: access", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("only users with products.manage get in", async ({ expect }) => {
    const ctx = await setup();
    const { id } = await createProduct(ctx.actor, normalized(ctx));
    const cashier = await loginAs(
      await makeUser({ roleName: "cashier-products", permissions: ROLE_PERMISSIONS.cashier }),
    );
    const accountant = await loginAs(
      await makeUser({ roleName: "accountant-products", permissions: ROLE_PERMISSIONS.accountant }),
    );
    const routes = [
      ["get", "/products"],
      ["get", "/products/create"],
      ["post", "/products"],
      ["get", `/products/${id}/edit`],
      ["post", `/products/${id}`],
      ["post", `/products/${id}/status`],
    ];

    for (const [method, path] of routes) {
      for (const who of [cashier, accountant]) {
        expect([method, path, (await who[method](path, HTML)).status]).toEqual([method, path, 403]);
      }

      const signedOut = await new TestSession()[method](path, HTML);

      expect([method, path, signedOut.status, signedOut.location]).toEqual([
        method,
        path,
        302,
        "/login-page",
      ]);
    }

    expect((await ctx.http.get("/products", HTML)).status).toBe(200);
  });
});

test.group("product pages: list", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("filters by text, status and category, with paging that keeps the filters", async ({
    expect,
  }) => {
    const ctx = await setup();
    const pain = await makeCategory({ name: "Pain" });

    await createProduct(
      ctx.actor,
      normalized(ctx, { sku: "A-1", productName: "Alpha", categoryId: pain.id }),
    );
    await createProduct(
      ctx.actor,
      normalized(ctx, { sku: "B-2", productName: "Bravo", brandName: "Painex" }),
    );
    await createProduct(
      ctx.actor,
      normalized(ctx, { sku: "C-3", productName: "Retired", isActive: false }),
    );

    const all = await ctx.http.get("/products", HTML);
    const search = await ctx.http.get("/products?q=PAINEX", HTML);
    const inactive = await ctx.http.get("/products?status=inactive", HTML);
    const category = await ctx.http.get(`/products?categoryId=${pain.id}`, HTML);
    const empty = await ctx.http.get("/products?q=zzz", HTML);

    expect(all.status).toBe(200);
    expect(all.text).toContain("Alpha");
    expect(all.text).toContain("Bravo");
    expect(all.text).not.toContain("Retired");
    expect(search.text).toContain("Bravo");
    expect(search.text).not.toContain("Alpha");
    expect(inactive.text).toContain("Retired");
    expect(inactive.text).not.toContain("Alpha");
    expect(category.text).toContain("Alpha");
    expect(category.text).not.toContain("Bravo");
    expect(empty.text).toContain("No products found");
  });

  test("a search of % matches only a literal %, and page 2 keeps the search", async ({
    expect,
  }) => {
    const ctx = await setup();

    for (let number = 1; number <= 21; number += 1) {
      await createProduct(
        ctx.actor,
        normalized(ctx, {
          sku: `P-${number}`,
          productName: `Item ${String(number).padStart(2, "0")}`,
        }),
      );
    }

    await createProduct(ctx.actor, normalized(ctx, { sku: "PCT", productName: "Fifty% off" }));

    const percent = await ctx.http.get("/products?q=%25", HTML);
    const second = await ctx.http.get("/products?q=Item&page=2", HTML);

    expect(percent.text).toContain("Fifty% off");
    expect(percent.text).not.toContain("Item 01");
    expect(second.text).toContain("Item 21");
    expect(second.text).not.toContain("Item 01");
    expect(second.text).toContain("q&#x3D;Item"); // in the pagination links (Handlebars escapes =)
  });

  test("HTML in names is escaped on the list, the form and the flash (review focus 3)", async ({
    expect,
  }) => {
    const ctx = await setup();

    const created = await ctx.http.post("/products", {
      ...HTML,
      form: post(ctx, {
        productName: XSS,
        brandName: XSS,
        genericName: XSS,
        "units[0][barcodes]": "<b>1</b>",
      }),
    });
    const list = await ctx.http.get("/products", HTML);
    const [row] = await db.select().from(products);
    const edit = await ctx.http.get(`/products/${row.id}/edit`, HTML);

    expect(created.status).toBe(302);
    expect(list.text).not.toContain("<img src=x");
    expect(list.text).toContain("&lt;img");
    expect(list.text).toContain('<meta name="flash-success" content="Product &quot;&lt;img');
    expect(edit.text).not.toContain("<img src=x");
    expect(edit.text).not.toContain("<b>1</b>");
    expect(edit.text).toContain("&lt;img");
  });
});

test.group("product pages: create and edit", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("the empty form offers units and lookups, and a row template for the script", async ({
    expect,
  }) => {
    const ctx = await setup();
    await makeCategory({ name: "Pain" });
    await makeManufacturer({ name: "Acme Labs" });

    const page = await ctx.http.get("/products/create", HTML);

    expect(page.status).toBe(200);
    expect(page.text).toContain('action="/products"');
    expect(page.text).toContain('name="sku"');
    expect(page.text).toContain("Pain");
    expect(page.text).toContain("Acme Labs");
    expect(page.text).toContain('name="units[0][unitId]"');
    expect(page.text).toContain('<template id="unit-row-template"');
    expect(page.text).toContain("__INDEX__");
    expect(page.text).toContain('src="/js/product-form.js"');
  });

  test("a created product is listed and a cashier can find it in the POS lookup", async ({
    expect,
  }) => {
    const ctx = await setup();
    const cashier = await loginAs(
      await makeUser({ roleName: "cashier-products", permissions: ROLE_PERMISSIONS.cashier }),
    );
    const branch = await makeBranch();

    const response = await ctx.http.post("/products", {
      ...HTML,
      form: post(ctx, {
        productName: "Fresh syrup",
        "units[0][barcodes]": "9990001",
        "units[1][unitId]": ctx.strip,
        "units[1][conversionFactor]": "10",
        "units[1][canBeSold]": "on",
        "units[1][isActive]": "on",
        "units[1][price]": "30",
      }),
    });
    const lookup = await cashier.get("/api/v1/products?q=fresh");
    const [item] = lookup.json().data;

    expect([response.status, response.location]).toEqual([302, "/products"]);
    expect(branch.id).toBeTruthy();
    expect(item.name).toBe("Fresh syrup");
    expect(
      item.units.map((unit) => {
        return [unit.name, unit.price];
      }),
    ).toEqual([
      ["Tablet", "3.5000"],
      ["Strip", "30.0000"],
    ]);
    expect(item.units[0].barcodes).toEqual(["9990001"]);
  });

  test("errors re-render the form with the typed values and write nothing (review focus 1, 4)", async ({
    expect,
  }) => {
    const ctx = await setup();
    await createProduct(ctx.actor, normalized(ctx, { sku: "TAKEN" }));
    const before = await productCount();

    const duplicate = await ctx.http.post("/products", {
      ...HTML,
      form: post(ctx, { sku: "TAKEN", productName: "Typed name" }),
    });
    const noBase = await ctx.http.post("/products", {
      ...HTML,
      form: post(ctx, { "units[0][isBaseUnit]": undefined, genericName: "Typed generic" }),
    });
    const badFactor = await ctx.http.post("/products", {
      ...HTML,
      form: post(ctx, {
        "units[1][unitId]": ctx.strip,
        "units[1][conversionFactor]": "abc",
        "units[1][canBeSold]": "on",
        "units[1][price]": "1",
      }),
    });

    expect(duplicate.status).toBe(422);
    expect(duplicate.text).toContain("That SKU is already used by another product");
    expect(duplicate.text).toContain('value="Typed name"');
    expect(noBase.status).toBe(422);
    expect(noBase.text).toContain("Choose exactly one base unit");
    expect(noBase.text).toContain('value="Typed generic"');
    expect(badFactor.status).toBe(422);
    expect(badFactor.text).toContain("Conversion factor must be more than zero");
    expect(await productCount()).toBe(before);
  });

  test("a product with stock shows the lock notice and refuses crafted factor changes", async ({
    expect,
  }) => {
    const ctx = await setup();
    const branch = await makeBranch();
    const { id } = await createProduct(
      ctx.actor,
      normalized(ctx, {
        units: [
          unitInput(ctx.tablet),
          unitInput(ctx.strip, { conversionFactor: "10.000", isBaseUnit: false }),
        ],
      }),
    );
    await makeStock({ productId: id, branchId: branch.id, batches: [{ quantity: "5" }] });
    const [[tabletRow], [stripRow]] = await Promise.all([
      pool.query("SELECT id FROM product_units WHERE product_id = ? AND is_base_unit = 1", [id]),
      pool.query("SELECT id FROM product_units WHERE product_id = ? AND is_base_unit = 0", [id]),
    ]);

    const page = await ctx.http.get(`/products/${id}/edit`, HTML);
    const crafted = await ctx.http.post(`/products/${id}`, {
      ...HTML,
      form: post(ctx, {
        sku: "SKU-0",
        "units[0][id]": tabletRow[0].id,
        "units[1][id]": stripRow[0].id,
        "units[1][unitId]": ctx.strip,
        "units[1][conversionFactor]": "12",
        "units[1][canBeSold]": "on",
        "units[1][isActive]": "on",
        "units[1][price]": "3.5",
      }),
    });
    const [[unit]] = await pool.query(
      "SELECT conversion_factor AS factor FROM product_units WHERE id = ?",
      [stripRow[0].id],
    );

    expect(page.text).toContain("stock or sales");
    expect(page.text).toContain("readonly");
    expect(crafted.status).toBe(422);
    expect(crafted.text).toContain("cannot be changed once the product has stock or sales");
    expect(unit.factor).toBe("10.000");
  });

  test("update saves, shows the saved values, and the status route flips activity", async ({
    expect,
  }) => {
    const ctx = await setup();
    const { id } = await createProduct(ctx.actor, normalized(ctx));
    const [[tablet]] = await pool.query("SELECT id FROM product_units WHERE product_id = ?", [id]);

    const saved = await ctx.http.post(`/products/${id}`, {
      ...HTML,
      form: post(ctx, {
        sku: "SKU-0",
        productName: "Renamed",
        "units[0][id]": tablet.id,
        "units[0][price]": "4",
      }),
    });
    const edit = await ctx.http.get(`/products/${id}/edit`, HTML);
    const off = await ctx.http.post(`/products/${id}/status`, { ...HTML, form: { active: "0" } });
    const [afterOff] = await db.select().from(products).where(eq(products.id, id));
    const on = await ctx.http.post(`/products/${id}/status`, { ...HTML, form: { active: "1" } });
    const [afterOn] = await db.select().from(products).where(eq(products.id, id));

    expect([saved.status, saved.location]).toEqual([302, "/products"]);
    expect(edit.text).toContain('value="Renamed"');
    expect(edit.text).toContain('value="4.0000"');
    expect([off.status, afterOff.isActive]).toEqual([302, false]);
    expect([on.status, afterOn.isActive]).toEqual([302, true]);
  });

  test("an unknown or malformed id is a 404 page everywhere", async ({ expect }) => {
    const ctx = await setup();

    for (const id of [randomUUID(), "not-a-uuid", "%C3%A9"]) {
      for (const [method, path] of [
        ["get", `/products/${id}/edit`],
        ["post", `/products/${id}`],
        ["post", `/products/${id}/status`],
      ]) {
        const response = await ctx.http[method](path, {
          ...HTML,
          ...(method === "post" ? { form: { ...post(ctx), active: "1" } } : {}),
        });

        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
    }
  });
});

test.group("product form script", () => {
  test("is served as JavaScript and never writes markup", async ({ expect }) => {
    const served = await new TestSession().get("/js/product-form.js");
    const source = await readFile(SCRIPT, "utf8");

    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toMatch(/javascript/);
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
    expect(source.includes("{{")).toBe(false);
  });
});
