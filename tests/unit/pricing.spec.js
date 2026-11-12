import { test } from "@japa/runner";
import { pickPrice } from "../../app/services/catalog/pricing.js";

const NOW = new Date("2026-11-12T08:00:00Z");
const MAIN = "branch-main";
const NORTH = "branch-north";

function row(overrides = {}) {
  return {
    branchId: null,
    unitPrice: "10.0000",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    isActive: true,
    ...overrides,
  };
}

test.group("pickPrice", () => {
  test("a branch row beats a global row, even a newer global one", ({ expect }) => {
    const rows = [
      row({
        unitPrice: "12.0000",
        branchId: MAIN,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      }),
      row({ unitPrice: "9.0000", effectiveFrom: new Date("2026-10-01T00:00:00Z") }),
    ];

    expect(pickPrice(rows, MAIN, NOW)).toBe("12.0000");
    expect(pickPrice(rows, NORTH, NOW)).toBe("9.0000");
  });

  test("within one specificity the later effectiveFrom wins", ({ expect }) => {
    const rows = [
      row({ unitPrice: "10.0000", effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
      row({ unitPrice: "11.0000", effectiveFrom: new Date("2026-06-01T00:00:00Z") }),
      row({ unitPrice: "10.5000", effectiveFrom: new Date("2026-03-01T00:00:00Z") }),
    ];

    expect(pickPrice(rows, MAIN, NOW)).toBe("11.0000");
  });

  test("ignores rows that are inactive, expired or not yet effective", ({ expect }) => {
    const ignored = [
      row({ unitPrice: "1.0000", isActive: false }),
      row({ unitPrice: "2.0000", effectiveTo: new Date("2026-11-01T00:00:00Z") }),
      row({ unitPrice: "3.0000", effectiveFrom: new Date("2026-11-13T00:00:00Z") }),
    ];

    expect(pickPrice(ignored, MAIN, NOW)).toBeNull();
    expect(pickPrice([...ignored, row({ unitPrice: "10.0000" })], MAIN, NOW)).toBe("10.0000");
  });

  test("a row is effective from its start instant up to, but not including, its end instant", ({
    expect,
  }) => {
    const starting = row({ unitPrice: "5.0000", effectiveFrom: NOW });
    const ending = row({ unitPrice: "6.0000", effectiveTo: NOW });
    const endingLater = row({ unitPrice: "7.0000", effectiveTo: new Date(NOW.getTime() + 1) });

    expect(pickPrice([starting], MAIN, NOW)).toBe("5.0000");
    expect(pickPrice([ending], MAIN, NOW)).toBeNull();
    expect(pickPrice([endingLater], MAIN, NOW)).toBe("7.0000");
  });

  test("an expired branch row falls back to the current global row", ({ expect }) => {
    const rows = [
      row({ unitPrice: "12.0000", branchId: MAIN, effectiveTo: new Date("2026-11-01T00:00:00Z") }),
      row({ unitPrice: "9.0000" }),
    ];

    expect(pickPrice(rows, MAIN, NOW)).toBe("9.0000");
  });

  test("no rows, or no branch, means only global rows count", ({ expect }) => {
    expect(pickPrice([], MAIN, NOW)).toBeNull();
    expect(pickPrice([row({ unitPrice: "12.0000", branchId: MAIN })], null, NOW)).toBeNull();
    expect(pickPrice([row({ unitPrice: "9.0000" })], null, NOW)).toBe("9.0000");
  });

  test("the price comes back with four decimal places", ({ expect }) => {
    expect(pickPrice([row({ unitPrice: "30" })], MAIN, NOW)).toBe("30.0000");
    expect(pickPrice([row({ unitPrice: "12.5" })], MAIN, NOW)).toBe("12.5000");
  });

  test("equal start instants resolve to the lower price", ({ expect }) => {
    const start = new Date("2026-06-01T00:00:00Z");
    const rows = [
      row({ unitPrice: "11.0000", effectiveFrom: start }),
      row({ unitPrice: "10.0000", effectiveFrom: start }),
    ];

    expect(pickPrice(rows, MAIN, NOW)).toBe("10.0000");
    expect(pickPrice([...rows].reverse(), MAIN, NOW)).toBe("10.0000");
  });
});
