import { test } from "@japa/runner";
import { ValidationError } from "../../app/http/errors.js";
import { productRequest } from "../../app/http/requests/product/productRequest.js";

const TABLET = "11111111-1111-4111-8111-111111111111";
const STRIP = "22222222-2222-4222-8222-222222222222";
const BOX = "33333333-3333-4333-8333-333333333333";

const unit = (overrides = {}) => {
  return {
    unitId: TABLET,
    conversionFactor: "1",
    isBaseUnit: "on",
    canBeSold: "on",
    isActive: "on",
    barcodes: "",
    price: "3.5",
    ...overrides,
  };
};

const body = (overrides = {}) => {
  return {
    sku: "PARA-500-001",
    productName: "Paracetamol 500 mg Tablet",
    genericName: "Paracetamol",
    prescriptionClassification: "OTC",
    reorderLevel: "",
    units: { 0: unit() },
    ...overrides,
  };
};

const paths = (input) => {
  try {
    productRequest(input);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.details.map((detail) => {
        return detail.path;
      });
    }

    throw error;
  }

  return [];
};

test.group("productRequest: normalizing", () => {
  test("a minimal body gets exact decimal strings, booleans and nulls", ({ expect }) => {
    expect(productRequest(body())).toEqual({
      sku: "PARA-500-001",
      productName: "Paracetamol 500 mg Tablet",
      genericName: "Paracetamol",
      brandName: null,
      strength: null,
      dosageForm: null,
      categoryId: null,
      manufacturerId: null,
      description: null,
      prescriptionClassification: "OTC",
      requiresPrescription: false,
      reorderLevel: "0.000",
      isActive: false,
      units: [
        {
          id: null,
          unitId: TABLET,
          conversionFactor: "1.000",
          isBaseUnit: true,
          canBeSold: true,
          isActive: true,
          barcodes: [],
          price: "3.5000",
        },
      ],
    });
  });

  test("units as an array equal units keyed by index", ({ expect }) => {
    const keyed = productRequest(
      body({
        units: {
          0: unit(),
          1: unit({ unitId: STRIP, isBaseUnit: undefined, conversionFactor: "10" }),
        },
      }),
    );
    const listed = productRequest(
      body({
        units: [unit(), unit({ unitId: STRIP, isBaseUnit: undefined, conversionFactor: "10" })],
      }),
    );

    expect(keyed).toEqual(listed);
    expect(keyed.units).toHaveLength(2);
  });

  test("checkbox values and optional text are read the way a browser sends them", ({ expect }) => {
    const input = productRequest(
      body({
        isActive: "on",
        requiresPrescription: "1",
        brandName: "  Biogesic ",
        strength: "",
        categoryId: "",
        units: { 0: unit({ id: "", canBeSold: undefined, price: "9" }) },
      }),
    );

    expect(input).toMatchObject({
      isActive: true,
      requiresPrescription: true,
      brandName: "Biogesic",
      strength: null,
      categoryId: null,
    });
    expect(input.units[0]).toMatchObject({ id: null, canBeSold: false, price: null });
  });

  test("barcodes are split on commas and spaces", ({ expect }) => {
    const input = productRequest(body({ units: { 0: unit({ barcodes: "A1, B2  C3" }) } }));

    expect(input.units[0].barcodes).toEqual(["A1", "B2", "C3"]);
  });

  test("prescription and controlled products always require a prescription", ({ expect }) => {
    for (const prescriptionClassification of ["PRESCRIPTION", "CONTROLLED"]) {
      expect(productRequest(body({ prescriptionClassification })).requiresPrescription).toBe(true);
    }

    expect(productRequest(body({ requiresPrescription: "on" })).requiresPrescription).toBe(true);
  });
});

test.group("productRequest: refusing", () => {
  test("the units need exactly one base unit and it has factor 1", ({ expect }) => {
    const second = unit({ unitId: STRIP, conversionFactor: "10" });

    expect(paths(body({ units: { 0: unit({ isBaseUnit: undefined }) } }))).toEqual(["units"]);
    expect(paths(body({ units: { 0: unit(), 1: { ...second, isBaseUnit: "on" } } }))).toEqual([
      "units",
    ]);
    expect(paths(body({ units: { 0: unit({ conversionFactor: "2" }) } }))).toEqual([
      "units.0.conversionFactor",
    ]);
  });

  test("a bad factor is refused at its row", ({ expect }) => {
    for (const conversionFactor of ["0", "-1", "abc", "1.2345", "123456789012", "", "1e3"]) {
      const input = body({
        units: { 0: unit(), 1: unit({ unitId: STRIP, isBaseUnit: undefined, conversionFactor }) },
      });

      expect([conversionFactor, paths(input)]).toEqual([
        conversionFactor,
        ["units.1.conversionFactor"],
      ]);
    }
  });

  test("units may not repeat, there are 1 to 10 of them", ({ expect }) => {
    expect(paths(body({ units: { 0: unit(), 1: unit({ isBaseUnit: undefined }) } }))).toContain(
      "units.1.unitId",
    );
    expect(paths(body({ units: {} }))).toEqual(["units"]);
    expect(paths(body({ units: undefined }))).toEqual(["units"]);

    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => {
        return [
          index,
          unit({ unitId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111` }),
        ];
      }),
    );

    expect(paths(body({ units: eleven }))).toContain("units");
  });

  test("a unit row id may appear once: a repeat could delete a unit and hide the base unit", ({
    expect,
  }) => {
    const id = "44444444-4444-4444-8444-444444444444";
    const input = body({
      units: {
        0: unit({ id }),
        1: unit({ id, unitId: STRIP, isBaseUnit: undefined, conversionFactor: "50" }),
      },
    });

    expect(paths(input)).toEqual(["units.1.id"]);
  });

  test("a sellable unit needs a price of zero or more with at most 4 decimals", ({ expect }) => {
    for (const price of ["", "-1", "1.00001", "1e3", "abc", "12345678901"]) {
      expect([price, paths(body({ units: { 0: unit({ price }) } }))]).toEqual([
        price,
        ["units.0.price"],
      ]);
    }

    expect(productRequest(body({ units: { 0: unit({ price: "0" }) } })).units[0].price).toBe(
      "0.0000",
    );
  });

  test("barcodes: at most 5, 100 characters, none repeated within the product", ({ expect }) => {
    expect(paths(body({ units: { 0: unit({ barcodes: "a b c d e f" }) } }))).toEqual([
      "units.0.barcodes",
    ]);
    expect(paths(body({ units: { 0: unit({ barcodes: "x".repeat(101) }) } }))).toEqual([
      "units.0.barcodes",
    ]);
    expect(
      paths(
        body({
          units: {
            0: unit({ barcodes: "A1" }),
            1: unit({
              unitId: STRIP,
              isBaseUnit: undefined,
              conversionFactor: "10",
              barcodes: "A1",
            }),
          },
        }),
      ),
    ).toEqual(["units.1.barcodes"]);
  });

  test("product fields: sku, names, ids, class, reorder level", ({ expect }) => {
    expect(paths(body({ sku: "" }))).toEqual(["sku"]);
    expect(paths(body({ sku: "x".repeat(101) }))).toEqual(["sku"]);
    expect(paths(body({ productName: " " }))).toEqual(["productName"]);
    expect(paths(body({ genericName: "" }))).toEqual(["genericName"]);
    expect(paths(body({ categoryId: "not-a-uuid" }))).toEqual(["categoryId"]);
    expect(paths(body({ manufacturerId: "é" }))).toEqual(["manufacturerId"]);
    expect(paths(body({ prescriptionClassification: "MAGIC" }))).toEqual([
      "prescriptionClassification",
    ]);
    expect(paths(body({ description: "x".repeat(2001) }))).toEqual(["description"]);

    for (const reorderLevel of ["abc", "-1", "1.2345", "123456789012"]) {
      expect([reorderLevel, paths(body({ reorderLevel }))]).toEqual([
        reorderLevel,
        ["reorderLevel"],
      ]);
    }
  });

  test("a body that is not an object is a validation error, never a crash", ({ expect }) => {
    for (const input of [null, undefined, "x", 5, []]) {
      expect(paths(input).length).toBeGreaterThan(0);
    }
  });

  test("an unused third unit id keeps the row order", ({ expect }) => {
    const input = productRequest(
      body({
        units: [
          unit(),
          unit({ unitId: STRIP, isBaseUnit: undefined, conversionFactor: "10" }),
          unit({ unitId: BOX, isBaseUnit: undefined, conversionFactor: "100" }),
        ],
      }),
    );

    expect(
      input.units.map((row) => {
        return row.conversionFactor;
      }),
    ).toEqual(["1.000", "10.000", "100.000"]);
  });
});
