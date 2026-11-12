import * as z from "zod";
import { cmp, toScale } from "../../../services/support/decimal.js";
import { ValidationError } from "../../errors.js";
import { parse } from "../validate.js";

const CLASSES = ["OTC", "PRESCRIPTION", "CONTROLLED", "OTHER"];
const ALWAYS_PRESCRIBED = ["PRESCRIPTION", "CONTROLLED"];
const MAX_UNITS = 10;
const MAX_BARCODES = 5;

// ---- reading what a browser sends ----

const flag = (value) => {
  return value === true || value === "on" || value === "1" || value === "true";
};

const clean = (value) => {
  return typeof value === "string" ? value.trim() : value;
};

// "" and missing mean "not given"; anything else is kept (even a non-string) so validation can refuse it.
const blank = (value) => {
  const text = clean(value);

  return text === "" || text === undefined || text === null ? null : text;
};

// Express turns units[0][unitId] into an array, or an object keyed by index when indexes are sparse.
function rows(units) {
  if (Array.isArray(units)) {
    return units;
  }

  if (units && typeof units === "object") {
    return Object.keys(units)
      .sort((a, b) => {
        return Number(a) - Number(b);
      })
      .map((key) => {
        return units[key];
      });
  }

  return [];
}

function barcodesOf(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];

  return parts
    .map((part) => {
      return typeof part === "string" ? part.trim() : "";
    })
    .filter(Boolean);
}

function normalize(body) {
  return {
    sku: clean(body.sku),
    productName: clean(body.productName),
    genericName: clean(body.genericName),
    brandName: blank(body.brandName),
    strength: blank(body.strength),
    dosageForm: blank(body.dosageForm),
    categoryId: blank(body.categoryId),
    manufacturerId: blank(body.manufacturerId),
    description: blank(body.description),
    prescriptionClassification: clean(body.prescriptionClassification),
    requiresPrescription: flag(body.requiresPrescription),
    reorderLevel: blank(body.reorderLevel) ?? "0",
    isActive: flag(body.isActive),
    units: rows(body.units).map((row) => {
      const unit = row && typeof row === "object" ? row : {};
      const canBeSold = flag(unit.canBeSold);

      return {
        id: blank(unit.id),
        unitId: clean(unit.unitId),
        conversionFactor: clean(unit.conversionFactor),
        isBaseUnit: flag(unit.isBaseUnit),
        canBeSold,
        isActive: flag(unit.isActive),
        barcodes: barcodesOf(unit.barcodes),
        price: canBeSold ? (clean(unit.price) ?? "") : null,
      };
    }),
  };
}

// ---- checking it ----

// One message per field: a pattern for the shape, so text that is not a number never reaches cmp().
const amount = (label, whole, places, { positive = false } = {}) => {
  const pattern = new RegExp(`^\\d{1,${whole}}(\\.\\d{1,${places}})?$`);
  const message = `${label} must be ${positive ? "more than zero" : "zero or more"}, with at most ${places} decimals`;

  return z
    .string({ error: `${label} is required` })
    .refine((value) => {
      return pattern.test(value) && (!positive || cmp(value, "0") > 0);
    }, message)
    .transform((value) => {
      return toScale(value, places);
    });
};

const optionalText = (label, max) => {
  return z
    .string({ error: `${label} must be text` })
    .max(max, `${label} must be at most ${max} characters`)
    .nullable();
};

const Unit = z
  .object({
    id: z.uuid({ error: "Unknown unit row" }).nullable(),
    unitId: z.uuid({ error: "Choose a unit" }),
    conversionFactor: amount("Conversion factor", 11, 3, { positive: true }),
    isBaseUnit: z.boolean(),
    canBeSold: z.boolean(),
    isActive: z.boolean(),
    barcodes: z.array(z.string()),
    price: z.string().nullable(),
  })
  .superRefine((unit, context) => {
    const tooLong = unit.barcodes.some((code) => {
      return code.length > 100;
    });

    if (unit.barcodes.length > MAX_BARCODES || tooLong) {
      context.addIssue({
        code: "custom",
        path: ["barcodes"],
        message: `At most ${MAX_BARCODES} barcodes of up to 100 characters`,
      });
    }

    if (unit.canBeSold && !/^\d{1,10}(\.\d{1,4})?$/.test(unit.price ?? "")) {
      context.addIssue({
        code: "custom",
        path: ["price"],
        message: "A sellable unit needs a price of zero or more, with at most 4 decimals",
      });
    }
  })
  .transform((unit) => {
    return { ...unit, price: unit.price === null ? null : toScale(unit.price, 4) };
  });

function checkUnits(units, context) {
  const bases = units.filter((unit) => {
    return unit.isBaseUnit;
  });
  const seenUnits = new Set();
  const seenBarcodes = new Set();

  if (units.length === 0) {
    return; // already reported as "Add at least one unit"
  }

  if (bases.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["units"],
      message: "Choose exactly one base unit",
    });
  } else if (bases[0].conversionFactor !== "1.000") {
    context.addIssue({
      code: "custom",
      path: ["units", units.indexOf(bases[0]), "conversionFactor"],
      message: "The base unit's conversion factor must be 1",
    });
  }

  units.forEach((unit, index) => {
    if (seenUnits.has(unit.unitId)) {
      context.addIssue({
        code: "custom",
        path: ["units", index, "unitId"],
        message: "Each unit can be used once",
      });
    }

    seenUnits.add(unit.unitId);

    if (
      unit.barcodes.some((code) => {
        return seenBarcodes.has(code);
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["units", index, "barcodes"],
        message: "A barcode can be used once",
      });
    }

    for (const code of unit.barcodes) {
      seenBarcodes.add(code);
    }
  });
}

const Product = z
  .object({
    sku: z
      .string({ error: "SKU is required" })
      .min(1, "SKU is required")
      .max(100, "SKU must be at most 100 characters"),
    productName: z
      .string({ error: "Product name is required" })
      .min(1, "Product name is required")
      .max(255, "Product name must be at most 255 characters"),
    genericName: z
      .string({ error: "Generic name is required" })
      .min(1, "Generic name is required")
      .max(255, "Generic name must be at most 255 characters"),
    brandName: optionalText("Brand name", 255),
    strength: optionalText("Strength", 100),
    dosageForm: optionalText("Dosage form", 100),
    categoryId: z.uuid({ error: "Choose a category from the list" }).nullable(),
    manufacturerId: z.uuid({ error: "Choose a manufacturer from the list" }).nullable(),
    description: optionalText("Description", 2000),
    prescriptionClassification: z.enum(CLASSES, { error: "Choose a classification" }),
    requiresPrescription: z.boolean(),
    reorderLevel: amount("Reorder level", 11, 3),
    isActive: z.boolean(),
    units: z
      .array(Unit, { error: "Add at least one unit" })
      .min(1, "Add at least one unit")
      .max(MAX_UNITS, `At most ${MAX_UNITS} units`),
  })
  .superRefine((product, context) => {
    checkUnits(product.units, context);
  })
  .transform((product) => {
    return {
      ...product,
      requiresPrescription:
        product.requiresPrescription ||
        ALWAYS_PRESCRIBED.includes(product.prescriptionClassification),
    };
  });

/**
 * Validates the product form and normalizes it for the product service: decimal strings with fixed
 * places, booleans for checkboxes, null for empty optional fields, barcodes as lists. Throws
 * ValidationError with paths such as `sku` and `units.1.conversionFactor`.
 */
export function productRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError([{ path: "body", message: "Send the product as a form" }]);
  }

  return parse(Product, normalize(body));
}
