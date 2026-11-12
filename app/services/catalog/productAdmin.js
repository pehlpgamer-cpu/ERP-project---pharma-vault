// Product administration (WF-03): list, read, create, edit and activate products with their units,
// barcodes and global selling prices. Every write is one READ COMMITTED transaction that ends with
// an audit row, so a failure leaves nothing behind.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { inventoryBatches } from "../../models/inventory-batches.js";
import { manufacturers } from "../../models/manufacturers.js";
import { productBarcodes } from "../../models/product-barcodes.js";
import { productCategories } from "../../models/product-categories.js";
import { productPrices } from "../../models/product-prices.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";
import { saleItems } from "../../models/sale-items.js";
import { units } from "../../models/units.js";
import { recordAudit } from "../audit/auditLog.js";
import { cmp } from "../support/decimal.js";
import { mysqlErrorCode } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";

const LOCKED = "cannot be changed once the product has stock or sales";

const notFound = () => {
  return new HttpError(404, "not_found", "Product not found");
};

const fieldError = (path, message) => {
  return new ValidationError([{ path, message }]);
};

// LIKE treats \, % and _ specially: escape them so a search matches those characters literally.
const escapeLike = (text) => {
  return text.replace(/[\\%_]/g, "\\$&");
};

// ---- reading ----

/** One page of products, by name. status: "active" (default), "inactive" or "any". */
export async function listProducts({
  q,
  status = "active",
  categoryId,
  page = 1,
  perPage = 20,
} = {}) {
  if (categoryId && !isUuid(categoryId)) {
    return { rows: [], total: 0 };
  }

  const conditions = [];

  if (status === "active") {
    conditions.push(eq(products.isActive, true));
  } else if (status === "inactive") {
    conditions.push(eq(products.isActive, false));
  }

  if (categoryId) {
    conditions.push(eq(products.categoryId, categoryId));
  }

  if (q && q.trim() !== "") {
    const pattern = `%${escapeLike(q.trim())}%`;

    conditions.push(
      or(
        like(products.sku, pattern),
        like(products.productName, pattern),
        like(products.genericName, pattern),
        like(products.brandName, pattern),
      ),
    );
  }

  const where = and(...conditions);
  const [{ total }] = await db.select({ total: count() }).from(products).where(where);
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      productName: products.productName,
      genericName: products.genericName,
      prescriptionClassification: products.prescriptionClassification,
      isActive: products.isActive,
      reorderLevel: products.reorderLevel,
      categoryName: productCategories.name,
      baseUnitName: units.name,
    })
    .from(products)
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(
      productUnits,
      and(eq(productUnits.productId, products.id), eq(productUnits.isBaseUnit, true)),
    )
    .leftJoin(units, eq(units.id, productUnits.unitId))
    .where(where)
    .orderBy(asc(products.productName), asc(products.sku))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return { rows, total: Number(total) };
}

/** The choices a product form offers: every category, manufacturer and unit by name. */
export async function loadFormOptions() {
  const [categories, makers, unitRows] = await Promise.all([
    db
      .select({ id: productCategories.id, name: productCategories.name })
      .from(productCategories)
      .orderBy(asc(productCategories.name)),
    db
      .select({ id: manufacturers.id, name: manufacturers.name })
      .from(manufacturers)
      .orderBy(asc(manufacturers.name)),
    db.select({ id: units.id, name: units.name }).from(units).orderBy(asc(units.name)),
  ]);

  return { categories, manufacturers: makers, units: unitRows };
}

async function hasHistory(executor, productId) {
  const [batch] = await executor
    .select({ id: inventoryBatches.id })
    .from(inventoryBatches)
    .where(eq(inventoryBatches.productId, productId))
    .limit(1);

  if (batch) {
    return true;
  }

  const [item] = await executor
    .select({ id: saleItems.id })
    .from(saleItems)
    .where(eq(saleItems.productId, productId))
    .limit(1);

  return Boolean(item);
}

// The product as the form shows it: its columns plus units with barcodes and the current global price.
async function loadForm(executor, row) {
  const unitRows = await executor
    .select({
      id: productUnits.id,
      unitId: productUnits.unitId,
      unitName: units.name,
      conversionFactor: productUnits.conversionFactor,
      isBaseUnit: productUnits.isBaseUnit,
      canBeSold: productUnits.canBeSold,
      isActive: productUnits.isActive,
    })
    .from(productUnits)
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(eq(productUnits.productId, row.id))
    .orderBy(asc(productUnits.conversionFactor), asc(productUnits.id));
  const ids = unitRows.map((unit) => {
    return unit.id;
  });
  const barcodeRows =
    ids.length === 0
      ? []
      : await executor
          .select()
          .from(productBarcodes)
          .where(inArray(productBarcodes.productUnitId, ids))
          .orderBy(desc(productBarcodes.isPrimary), asc(productBarcodes.barcode));
  const priceRows =
    ids.length === 0
      ? []
      : await executor
          .select()
          .from(productPrices)
          .where(
            and(
              inArray(productPrices.productUnitId, ids),
              isNull(productPrices.branchId),
              isNull(productPrices.effectiveTo),
              eq(productPrices.isActive, true),
            ),
          )
          .orderBy(desc(productPrices.effectiveFrom));

  return {
    id: row.id,
    sku: row.sku,
    productName: row.productName,
    genericName: row.genericName,
    brandName: row.brandName,
    strength: row.strength,
    dosageForm: row.dosageForm,
    categoryId: row.categoryId,
    manufacturerId: row.manufacturerId,
    description: row.description,
    prescriptionClassification: row.prescriptionClassification,
    requiresPrescription: row.requiresPrescription,
    reorderLevel: row.reorderLevel,
    isActive: row.isActive,
    units: unitRows.map((unit) => {
      return {
        ...unit,
        barcodes: barcodeRows
          .filter((code) => {
            return code.productUnitId === unit.id;
          })
          .map((code) => {
            return code.barcode;
          }),
        price:
          priceRows.find((price) => {
            return price.productUnitId === unit.id;
          })?.unitPrice ?? null,
      };
    }),
  };
}

/** The product's form values and whether it has stock or sales (null for an unknown or malformed id). */
export async function getProductForEdit(id) {
  if (!isUuid(id)) {
    return null;
  }

  const [row] = await db.select().from(products).where(eq(products.id, id));

  if (!row) {
    return null;
  }

  return { product: await loadForm(db, row), hasHistory: await hasHistory(db, id) };
}

// ---- writing ----

const productColumns = (input) => {
  return {
    sku: input.sku,
    productName: input.productName,
    genericName: input.genericName,
    brandName: input.brandName,
    strength: input.strength,
    dosageForm: input.dosageForm,
    categoryId: input.categoryId,
    manufacturerId: input.manufacturerId,
    description: input.description,
    prescriptionClassification: input.prescriptionClassification,
    requiresPrescription: input.requiresPrescription,
    reorderLevel: input.reorderLevel,
    isActive: input.isActive,
  };
};

// The category, manufacturer and units named by the form must exist.
async function checkReferences(tx, input) {
  const issues = [];

  if (input.categoryId) {
    const [found] = await tx
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(eq(productCategories.id, input.categoryId));

    if (!found) {
      issues.push({ path: "categoryId", message: "Choose a category from the list" });
    }
  }

  if (input.manufacturerId) {
    const [found] = await tx
      .select({ id: manufacturers.id })
      .from(manufacturers)
      .where(eq(manufacturers.id, input.manufacturerId));

    if (!found) {
      issues.push({ path: "manufacturerId", message: "Choose a manufacturer from the list" });
    }
  }

  const known = await tx
    .select({ id: units.id })
    .from(units)
    .where(
      inArray(
        units.id,
        input.units.map((unit) => {
          return unit.unitId;
        }),
      ),
    );
  const knownIds = new Set(
    known.map((unit) => {
      return unit.id;
    }),
  );

  input.units.forEach((unit, index) => {
    if (!knownIds.has(unit.unitId)) {
      issues.push({ path: `units.${index}.unitId`, message: "Choose a unit from the list" });
    }
  });

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
}

async function insertUnit(tx, productId, unit) {
  const id = randomUUID();

  await tx.insert(productUnits).values({
    id,
    productId,
    unitId: unit.unitId,
    conversionFactor: unit.conversionFactor,
    isBaseUnit: unit.isBaseUnit,
    canBeSold: unit.canBeSold,
    isActive: unit.isActive,
  });

  return id;
}

async function replaceBarcodes(tx, unitIds, desired) {
  if (unitIds.length > 0) {
    await tx.delete(productBarcodes).where(inArray(productBarcodes.productUnitId, unitIds));
  }

  const rows = desired.flatMap(({ unitRowId, barcodes }) => {
    return barcodes.map((barcode, index) => {
      return { productUnitId: unitRowId, barcode, isPrimary: index === 0 };
    });
  });

  if (rows.length > 0) {
    await tx.insert(productBarcodes).values(rows);
  }
}

// A changed global price closes the open row and opens a new one from `now`; history is never edited.
async function writePrice(tx, unitRowId, price, instant) {
  if (price === null) {
    return;
  }

  // DATETIME columns hold whole seconds and MySQL rounds a fraction up: round down ourselves, so a
  // price never starts in the future and a new product is sellable the moment it is saved.
  const now = new Date(Math.floor(instant.getTime() / 1000) * 1000);

  const open = await tx
    .select()
    .from(productPrices)
    .where(
      and(
        eq(productPrices.productUnitId, unitRowId),
        isNull(productPrices.branchId),
        isNull(productPrices.effectiveTo),
      ),
    );

  if (
    open.some((row) => {
      return row.unitPrice === price && row.isActive;
    })
  ) {
    return;
  }

  for (const row of open) {
    await tx.update(productPrices).set({ effectiveTo: now }).where(eq(productPrices.id, row.id));
  }

  await tx
    .insert(productPrices)
    .values({ productUnitId: unitRowId, branchId: null, unitPrice: price, effectiveFrom: now });
}

// MySQL's own refusals, in the form's words: a taken SKU or barcode, a unit still referenced elsewhere.
function translate(error, input) {
  if (error instanceof ValidationError || error instanceof HttpError) {
    return error;
  }

  const code = mysqlErrorCode(error);
  const text = String(error?.cause?.sqlMessage ?? error?.sqlMessage ?? error?.message ?? "");

  if (code === "ER_DUP_ENTRY") {
    const [, value = "", key = ""] = /Duplicate entry '(.*)' for key '([^']*)'/s.exec(text) ?? [];

    if (key.includes("uq_products_sku")) {
      return fieldError("sku", "That SKU is already used by another product");
    }

    if (key.includes("uq_product_barcodes_barcode")) {
      const index = input.units.findIndex((unit) => {
        return unit.barcodes.some((barcode) => {
          return barcode.toLowerCase() === value.toLowerCase();
        });
      });

      return fieldError(
        index >= 0 ? `units.${index}.barcodes` : "units",
        `The barcode ${value} is already used`,
      );
    }

    if (key.includes("uq_product_unit")) {
      return fieldError("units", "Each unit can be used once");
    }
  }

  if (code === "ER_ROW_IS_REFERENCED_2") {
    return fieldError("units", "That unit is used elsewhere; deactivate it instead of removing it");
  }

  return error;
}

async function write(input, work) {
  try {
    return await db.transaction(work, { isolationLevel: "read committed" });
  } catch (error) {
    throw translate(error, input);
  }
}

/** Creates a product with its units, barcodes and global prices. No stock is created. */
export async function createProduct(user, input, { now = new Date(), meta = {} } = {}) {
  const id = randomUUID();

  await write(input, async (tx) => {
    await checkReferences(tx, input);
    await tx.insert(products).values({ id, ...productColumns(input) });

    const desired = [];

    for (const unit of input.units) {
      const unitRowId = await insertUnit(tx, id, unit);

      desired.push({ unitRowId, barcodes: unit.barcodes });
      await writePrice(tx, unitRowId, unit.price, now);
    }

    await replaceBarcodes(tx, [], desired);
    await recordAudit(tx, {
      userId: user.id,
      branchId: user.branchId,
      action: "PRODUCT_CREATED",
      entityType: "product",
      entityId: id,
      newValues: input,
      ...meta,
    });
  });

  return { id };
}

async function lockProduct(tx, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await tx.select().from(products).where(eq(products.id, id)).for("update");

  if (!row) {
    throw notFound();
  }

  return row;
}

// Edits that the stock-or-sales lock forbids, and units that do not belong to the product.
function lockIssues(input, stored, locked) {
  const issues = [];
  const byId = new Map(
    stored.units.map((unit) => {
      return [unit.id, unit];
    }),
  );
  const kept = new Set();

  input.units.forEach((unit, index) => {
    if (unit.id === null) {
      if (locked && unit.isBaseUnit) {
        issues.push({ path: `units.${index}.isBaseUnit`, message: `The base unit ${LOCKED}` });
      }

      return;
    }

    const old = byId.get(unit.id);

    kept.add(unit.id);

    if (!old) {
      issues.push({
        path: `units.${index}.id`,
        message: "That unit row does not belong to this product",
      });
    } else if (locked) {
      if (unit.unitId !== old.unitId) {
        issues.push({ path: `units.${index}.unitId`, message: `The unit ${LOCKED}` });
      }

      if (cmp(unit.conversionFactor, old.conversionFactor) !== 0) {
        issues.push({
          path: `units.${index}.conversionFactor`,
          message: `The conversion factor ${LOCKED}`,
        });
      }

      if (unit.isBaseUnit !== old.isBaseUnit) {
        issues.push({ path: `units.${index}.isBaseUnit`, message: `The base unit ${LOCKED}` });
      }
    }
  });

  const removed = stored.units.filter((unit) => {
    return !kept.has(unit.id);
  });

  if (locked && removed.length > 0) {
    issues.push({
      path: "units",
      message: "Units of a product with stock or sales cannot be removed; deactivate them instead",
    });
  }

  return { issues, removed };
}

/** Saves the form over an existing product. See the edit lock in the design spec, section 6. */
export async function updateProduct(user, id, input, { now = new Date(), meta = {} } = {}) {
  await write(input, async (tx) => {
    const row = await lockProduct(tx, id);
    const locked = await hasHistory(tx, id);
    const stored = await loadForm(tx, row);

    await checkReferences(tx, input);

    const { issues, removed } = lockIssues(input, stored, locked);

    if (issues.length > 0) {
      throw new ValidationError(issues);
    }

    await tx.update(products).set(productColumns(input)).where(eq(products.id, id));

    if (removed.length > 0) {
      const removedIds = removed.map((unit) => {
        return unit.id;
      });

      await tx.delete(productBarcodes).where(inArray(productBarcodes.productUnitId, removedIds));
      await tx.delete(productPrices).where(inArray(productPrices.productUnitId, removedIds));
      await tx.delete(productUnits).where(inArray(productUnits.id, removedIds));
    }

    const desired = [];

    for (const unit of input.units) {
      let unitRowId = unit.id;

      if (unitRowId === null) {
        unitRowId = await insertUnit(tx, id, unit);
      } else {
        await tx
          .update(productUnits)
          .set({
            unitId: unit.unitId,
            conversionFactor: unit.conversionFactor,
            isBaseUnit: unit.isBaseUnit,
            canBeSold: unit.canBeSold,
            isActive: unit.isActive,
          })
          .where(eq(productUnits.id, unitRowId));
      }

      desired.push({ unitRowId, barcodes: unit.barcodes });
      await writePrice(tx, unitRowId, unit.price, now);
    }

    await replaceBarcodes(
      tx,
      desired.map((entry) => {
        return entry.unitRowId;
      }),
      desired,
    );
    await recordAudit(tx, {
      userId: user.id,
      branchId: user.branchId,
      action: "PRODUCT_UPDATED",
      entityType: "product",
      entityId: id,
      oldValues: stored,
      newValues: input,
      ...meta,
    });
  });

  return { id };
}

/** Activates or deactivates a product; changed is false when it already was in that state. */
export async function setProductActive(user, id, active, { meta = {} } = {}) {
  return write({ units: [] }, async (tx) => {
    const row = await lockProduct(tx, id);

    if (row.isActive === active) {
      return { id, changed: false };
    }

    await tx.update(products).set({ isActive: active }).where(eq(products.id, id));
    await recordAudit(tx, {
      userId: user.id,
      branchId: user.branchId,
      action: active ? "PRODUCT_ACTIVATED" : "PRODUCT_DEACTIVATED",
      entityType: "product",
      entityId: id,
      oldValues: { isActive: row.isActive },
      newValues: { isActive: active },
      ...meta,
    });

    return { id, changed: true };
  });
}
