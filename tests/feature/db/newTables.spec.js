import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { resetDatabase } from "../../helpers/db.js";
import { documentSequences } from "../../../app/models/document-sequences.js";
import { productPrices } from "../../../app/models/product-prices.js";
import { productUnits } from "../../../app/models/product-units.js";
import { products } from "../../../app/models/products.js";
import { units } from "../../../app/models/units.js";

async function makeProductUnit() {
  const unitId = randomUUID();
  const productId = randomUUID();
  const productUnitId = randomUUID();

  await db.insert(units).values({ id: unitId, name: "Tablet", abbreviation: "tab" });
  await db
    .insert(products)
    .values({ id: productId, sku: "SKU-1", genericName: "Generic", productName: "Product" });
  await db
    .insert(productUnits)
    .values({ id: productUnitId, productId, unitId, conversionFactor: "1", isBaseUnit: true });

  return productUnitId;
}

test.group("new tables", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("product_prices rejects a negative price", async ({ expect }) => {
    const productUnitId = await makeProductUnit();
    let error;

    try {
      await db.insert(productPrices).values({
        productUnitId,
        unitPrice: "-1.0000",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(String(error.cause?.message ?? error.message)).toMatch(/chk_product_prices_price/);
  });

  test("product_prices DATETIME round-trips as UTC", async ({ expect }) => {
    const productUnitId = await makeProductUnit();
    const id = randomUUID();

    await db.insert(productPrices).values({
      id,
      productUnitId,
      unitPrice: "30.0000",
      effectiveFrom: new Date("2026-11-12T03:15:00Z"),
    });
    const [row] = await db.select().from(productPrices).where(eq(productPrices.id, id));

    expect(row.effectiveFrom.toISOString()).toBe("2026-11-12T03:15:00.000Z");
    expect(row.unitPrice).toBe("30.0000");
    expect(row.branchId).toBeNull();
    expect(row.effectiveTo).toBeNull();
    expect(row.isActive).toBe(true);
  });

  test("document_sequences upsert increments", async ({ expect }) => {
    const scope = "invoice:MAIN:20261112";

    for (let attempt = 0; attempt < 3; attempt++) {
      await db
        .insert(documentSequences)
        .values({ scope, lastValue: 1 })
        .onDuplicateKeyUpdate({ set: { lastValue: sql`${documentSequences.lastValue} + 1` } });
    }
    const [row] = await db
      .select()
      .from(documentSequences)
      .where(eq(documentSequences.scope, scope));

    expect(row.lastValue).toBe(3);
  });
});
