import { test } from "@japa/runner";
import { allocateFefo, isEligibleBatch } from "../../app/services/sales/fefo.js";

const TODAY = "2026-11-12";

function batch(id, overrides = {}) {
  return {
    id,
    status: "ACTIVE",
    quantityAvailable: "100.000",
    expirationDate: "2027-06-30",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function run(batches, needed, options = {}) {
  return allocateFefo(batches, needed, { today: TODAY, ...options });
}

test.group("allocateFefo", () => {
  test("takes the earliest-expiring batch first and spills into the next", ({ expect }) => {
    const batches = [
      batch("B-001", { quantityAvailable: "100.000", expirationDate: "2027-03-31" }),
      batch("B-002", { quantityAvailable: "200.000", expirationDate: "2027-01-31" }),
      batch("B-003", { quantityAvailable: "150.000", expirationDate: "2027-07-31" }),
    ];

    expect(run(batches, "250.000")).toEqual({
      allocations: [
        { batchId: "B-002", quantity: "200.000" },
        { batchId: "B-001", quantity: "50.000" },
      ],
      shortfall: "0.000",
    });
  });

  test("skips expired, quarantined, recalled, depleted and empty batches", ({ expect }) => {
    const batches = [
      batch("EXPIRED", { expirationDate: "2026-11-11" }),
      batch("QUARANTINED", { status: "QUARANTINED" }),
      batch("RECALLED", { status: "RECALLED" }),
      batch("DEPLETED", { status: "DEPLETED" }),
      batch("EMPTY", { quantityAvailable: "0.000" }),
      batch("GOOD", { quantityAvailable: "10.000" }),
    ];

    expect(run(batches, "4.000").allocations).toEqual([{ batchId: "GOOD", quantity: "4.000" }]);
    expect(run(batches, "50.000")).toEqual({
      allocations: [{ batchId: "GOOD", quantity: "10.000" }],
      shortfall: "40.000",
    });
  });

  test("a batch expiring today is eligible with no buffer and skipped with a one-day buffer", ({
    expect,
  }) => {
    const batches = [batch("TODAY", { expirationDate: TODAY, quantityAvailable: "5.000" })];
    const tomorrow = [
      batch("TOMORROW", { expirationDate: "2026-11-13", quantityAvailable: "5.000" }),
    ];

    expect(run(batches, "1.000").allocations).toEqual([{ batchId: "TODAY", quantity: "1.000" }]);
    expect(run(batches, "1.000", { bufferDays: 1 })).toEqual({
      allocations: [],
      shortfall: "1.000",
    });
    expect(run(tomorrow, "1.000", { bufferDays: 1 }).allocations).toEqual([
      { batchId: "TOMORROW", quantity: "1.000" },
    ]);
  });

  test("an undated batch is used only after every dated batch", ({ expect }) => {
    const batches = [
      batch("UNDATED", {
        expirationDate: null,
        quantityAvailable: "50.000",
        receivedAt: new Date("2020-01-01T00:00:00Z"),
      }),
      batch("DATED", { expirationDate: "2030-01-01", quantityAvailable: "3.000" }),
    ];

    expect(run(batches, "5.000")).toEqual({
      allocations: [
        { batchId: "DATED", quantity: "3.000" },
        { batchId: "UNDATED", quantity: "2.000" },
      ],
      shortfall: "0.000",
    });
  });

  test("equal expiry dates fall back to the earlier receipt, then to the id", ({ expect }) => {
    const batches = [
      batch("B-3", { expirationDate: "2027-01-31", receivedAt: new Date("2026-03-01T00:00:00Z") }),
      batch("B-2", { expirationDate: "2027-01-31", receivedAt: "2026-02-01T00:00:00.000Z" }),
      batch("B-1", { expirationDate: "2027-01-31", receivedAt: new Date("2026-02-01T00:00:00Z") }),
    ];

    expect(run(batches, "250.000")).toEqual({
      allocations: [
        { batchId: "B-1", quantity: "100.000" },
        { batchId: "B-2", quantity: "100.000" },
        { batchId: "B-3", quantity: "50.000" },
      ],
      shortfall: "0.000",
    });
  });

  test("a need larger than the eligible stock takes everything and reports the shortfall", ({
    expect,
  }) => {
    const batches = [
      batch("B-1", { quantityAvailable: "100.000", expirationDate: "2027-01-31" }),
      batch("B-2", { quantityAvailable: "200.000", expirationDate: "2027-02-28" }),
    ];

    expect(run(batches, "305.000")).toEqual({
      allocations: [
        { batchId: "B-1", quantity: "100.000" },
        { batchId: "B-2", quantity: "200.000" },
      ],
      shortfall: "5.000",
    });
  });

  test("a need of zero allocates nothing", ({ expect }) => {
    expect(run([batch("B-1")], "0.000")).toEqual({ allocations: [], shortfall: "0.000" });
  });

  test("no batches at all is a full shortfall", ({ expect }) => {
    expect(run([], "2.500")).toEqual({ allocations: [], shortfall: "2.500" });
  });

  test("fractional quantities keep three decimal places", ({ expect }) => {
    expect(run([batch("B-1", { quantityAvailable: "0.500" })], "0.750")).toEqual({
      allocations: [{ batchId: "B-1", quantity: "0.500" }],
      shortfall: "0.250",
    });
  });

  test("leaves the batches it is given untouched", ({ expect }) => {
    const batches = [
      batch("LATE", { expirationDate: "2028-01-01" }),
      batch("SOON", { expirationDate: "2027-01-01" }),
    ];

    run(batches, "10.000");

    expect(
      batches.map((entry) => {
        return entry.id;
      }),
    ).toEqual(["LATE", "SOON"]);
  });
});

test.group("isEligibleBatch", () => {
  const options = { today: TODAY, bufferDays: 0 };

  test("needs an ACTIVE status, stock, and an expiry on or after today plus the buffer", ({
    expect,
  }) => {
    expect(isEligibleBatch(batch("A"), options)).toBe(true);
    expect(isEligibleBatch(batch("A", { status: "RECALLED" }), options)).toBe(false);
    expect(isEligibleBatch(batch("A", { quantityAvailable: "0.000" }), options)).toBe(false);
    expect(isEligibleBatch(batch("A", { expirationDate: "2026-11-11" }), options)).toBe(false);
    expect(isEligibleBatch(batch("A", { expirationDate: TODAY }), options)).toBe(true);
    expect(
      isEligibleBatch(batch("A", { expirationDate: TODAY }), { today: TODAY, bufferDays: 1 }),
    ).toBe(false);
    expect(isEligibleBatch(batch("A", { expirationDate: null }), options)).toBe(true);
  });

  test("reads a Date expiry by its calendar date and refuses an expiry it cannot read", ({
    expect,
  }) => {
    const on = batch("A", { expirationDate: new Date("2026-11-12T00:00:00Z") });
    const before = batch("A", { expirationDate: new Date("2026-11-11T00:00:00Z") });

    expect(isEligibleBatch(on, { today: TODAY })).toBe(true);
    expect(isEligibleBatch(before, { today: TODAY })).toBe(false);
    expect(isEligibleBatch(batch("A", { expirationDate: "soon" }), { today: TODAY })).toBe(false);
  });
});
