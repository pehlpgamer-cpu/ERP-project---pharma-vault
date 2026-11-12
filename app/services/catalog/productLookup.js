// Product search for the POS: what can be sold at a branch, in which units, at what price, and how
// much of it is on the shelf right now.

import { and, asc, desc, eq, exists, gt, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { productBarcodes } from "../../models/product-barcodes.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";
import { units } from "../../models/units.js";
import { isEligibleBatch } from "../sales/fefo.js";
import { add, toScale } from "../support/decimal.js";
import { expiryBufferDays } from "../support/settings.js";
import { businessDate } from "../support/time.js";
import { loadEffectivePrices } from "./pricing.js";

const QUANTITY_SCALE = 3;

const sellableUnit = and(eq(productUnits.isActive, true), eq(productUnits.canBeSold, true));

// LIKE treats \, % and _ specially: escape them so a search matches those characters literally.
const escapeLike = (text) => {
  return text.replace(/[\\%_]/g, "\\$&");
};

// The one sellable product that owns exactly this barcode, with the scanned unit.
async function findByBarcode(term) {
  const [row] = await db
    .select({ product: products, matchedUnitId: productUnits.id })
    .from(productBarcodes)
    .innerJoin(productUnits, eq(productUnits.id, productBarcodes.productUnitId))
    .innerJoin(products, eq(products.id, productUnits.productId))
    .where(and(eq(productBarcodes.barcode, term), sellableUnit, eq(products.isActive, true)))
    .limit(1);

  return row ?? null;
}

// Active products with a sellable unit whose SKU, name, generic name or brand contains the term.
function findByText(term, limit, excludedId) {
  const pattern = `%${escapeLike(term)}%`;

  return db
    .select()
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(productUnits)
            .where(and(eq(productUnits.productId, products.id), sellableUnit)),
        ),
        or(
          like(products.sku, pattern),
          like(products.productName, pattern),
          like(products.genericName, pattern),
          like(products.brandName, pattern),
        ),
        excludedId ? ne(products.id, excludedId) : undefined,
      ),
    )
    .orderBy(asc(products.productName), asc(products.sku))
    .limit(limit);
}

function loadUnits(productIds) {
  return db
    .select({
      productUnitId: productUnits.id,
      productId: productUnits.productId,
      name: units.name,
      abbreviation: units.abbreviation,
      conversionFactor: productUnits.conversionFactor,
    })
    .from(productUnits)
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(and(inArray(productUnits.productId, productIds), sellableUnit))
    .orderBy(asc(productUnits.conversionFactor), asc(units.name));
}

function loadBarcodes(unitIds) {
  return db
    .select({ productUnitId: productBarcodes.productUnitId, barcode: productBarcodes.barcode })
    .from(productBarcodes)
    .where(inArray(productBarcodes.productUnitId, unitIds))
    .orderBy(desc(productBarcodes.isPrimary), asc(productBarcodes.barcode));
}

// Base units a branch can sell today: the sum over batches that pass the shared eligibility rule.
async function loadAvailability(productIds, branchId, now) {
  const totals = new Map();

  if (!branchId) {
    return totals;
  }

  const batches = await db
    .select({
      productId: inventoryBatches.productId,
      status: inventoryBatches.status,
      quantityAvailable: inventoryBatches.quantityAvailable,
      expirationDate: inventoryBatches.expirationDate,
    })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.branchId, branchId),
        inArray(inventoryBatches.productId, productIds),
        eq(inventoryBatches.status, "ACTIVE"),
        gt(inventoryBatches.quantityAvailable, "0"),
      ),
    );
  const rule = { today: businessDate(now), bufferDays: expiryBufferDays() };

  for (const batch of batches) {
    if (isEligibleBatch(batch, rule)) {
      totals.set(batch.productId, add(totals.get(batch.productId) ?? "0", batch.quantityAvailable));
    }
  }

  return totals;
}

/**
 * Searches sellable products for a branch. An exact barcode match comes first (with the scanned unit
 * in matchedUnitId); then products whose SKU, name, generic name or brand contains `q`, by name.
 */
export async function searchProducts({ q, limit = 20, branchId, now = new Date() }) {
  const term = q.trim();

  if (term === "") {
    return [];
  }

  const scanned = await findByBarcode(term);
  const room = scanned ? limit - 1 : limit;
  const matches = room > 0 ? await findByText(term, room, scanned?.product.id) : [];
  const found = scanned ? [scanned.product, ...matches] : matches;

  if (found.length === 0) {
    return [];
  }

  const productIds = found.map((product) => {
    return product.id;
  });
  const unitRows = await loadUnits(productIds);
  const unitIds = unitRows.map((unit) => {
    return unit.productUnitId;
  });
  const [barcodeRows, prices, available] = await Promise.all([
    unitIds.length > 0 ? loadBarcodes(unitIds) : [],
    loadEffectivePrices(db, unitIds, branchId ?? null, now),
    loadAvailability(productIds, branchId, now),
  ]);
  const unitsByProduct = Map.groupBy(unitRows, (unit) => {
    return unit.productId;
  });
  const barcodesByUnit = Map.groupBy(barcodeRows, (row) => {
    return row.productUnitId;
  });

  return found.map((product) => {
    return {
      id: product.id,
      sku: product.sku,
      name: product.productName,
      genericName: product.genericName,
      strength: product.strength,
      dosageForm: product.dosageForm,
      classification: product.prescriptionClassification,
      requiresPrescription: product.requiresPrescription,
      availableBaseQuantity: toScale(available.get(product.id) ?? "0", QUANTITY_SCALE),
      matchedUnitId: scanned?.product.id === product.id ? scanned.matchedUnitId : null,
      units: (unitsByProduct.get(product.id) ?? []).map((unit) => {
        return {
          productUnitId: unit.productUnitId,
          name: unit.name,
          abbreviation: unit.abbreviation,
          conversionFactor: unit.conversionFactor,
          price: prices.get(unit.productUnitId) ?? null,
          barcodes: (barcodesByUnit.get(unit.productUnitId) ?? []).map((row) => {
            return row.barcode;
          }),
        };
      }),
    };
  });
}
