// Read-only medicine lookup for other systems (for example the pharmacy queue). It says which
// medicines the pharmacy carries, by name, generic name or brand. It never exposes prices, cost or stock.
import { and, asc, eq, exists, like, or, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";

// LIKE treats \, % and _ specially: escape them so a search matches those characters literally.
const escapeLike = (text) => {
  return text.replace(/[\\%_]/g, "\\$&");
};

/**
 * Active, sellable products whose name, generic name or brand contains `q`, by name. `status` is
 * always "ACTIVE" because inactive products are never returned.
 */
export async function searchMedicines({ q, limit }) {
  const pattern = `%${escapeLike(q.trim())}%`;
  const rows = await db
    .select({
      sku: products.sku,
      name: products.productName,
      genericName: products.genericName,
      brandName: products.brandName,
      strength: products.strength,
      dosageForm: products.dosageForm,
      requiresPrescription: products.requiresPrescription,
    })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(productUnits)
            .where(
              and(
                eq(productUnits.productId, products.id),
                eq(productUnits.isActive, true),
                eq(productUnits.canBeSold, true),
              ),
            ),
        ),
        or(
          like(products.productName, pattern),
          like(products.genericName, pattern),
          like(products.brandName, pattern),
        ),
      ),
    )
    .orderBy(asc(products.productName), asc(products.sku))
    .limit(limit);

  return rows.map((row) => {
    return {
      sku: row.sku,
      name: row.name,
      genericName: row.genericName ?? null,
      brandNames: row.brandName ? [row.brandName] : [],
      strength: row.strength ?? null,
      dosageForm: row.dosageForm ?? null,
      requiresPrescription: Boolean(row.requiresPrescription),
      status: "ACTIVE",
    };
  });
}
