import { test } from "@japa/runner";
import {
  addDays,
  businessDate,
  businessOffsetMinutes,
  businessTimeZone,
  eachDay,
  startOfBusinessDay,
  startOfNextBusinessDay,
  toDateString,
} from "../../app/services/support/time.js";

test.group("business time (Asia/Manila)", () => {
  test("defaults to Asia/Manila with a +480 minute offset", ({ expect }) => {
    expect(businessTimeZone()).toBe("Asia/Manila");
    expect(businessOffsetMinutes()).toBe(480);
  });

  test("businessDate switches at local midnight", ({ expect }) => {
    expect(businessDate(new Date("2026-11-12T15:59:59Z"))).toBe("2026-11-12");
    expect(businessDate(new Date("2026-11-12T16:00:00Z"))).toBe("2026-11-13");
  });

  test("day boundaries are UTC instants", ({ expect }) => {
    expect(startOfBusinessDay("2026-11-13").toISOString()).toBe("2026-11-12T16:00:00.000Z");
    expect(startOfNextBusinessDay("2026-11-12").toISOString()).toBe("2026-11-12T16:00:00.000Z");
  });

  test("addDays crosses month ends", ({ expect }) => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("eachDay is inclusive and empty when reversed", ({ expect }) => {
    expect(eachDay("2026-11-10", "2026-11-12")).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(eachDay("2026-11-12", "2026-11-10")).toEqual([]);
  });

  test("toDateString reads UTC date parts", ({ expect }) => {
    expect(toDateString(new Date("2027-01-31T00:00:00Z"))).toBe("2027-01-31");
    expect(toDateString("2027-01-31")).toBe("2027-01-31");
    expect(toDateString(null)).toBeNull();
    expect(toDateString(new Date("nope"))).toBeNull();
  });

  test("date helpers reject malformed dates", ({ expect }) => {
    expect(() => {
      return addDays("2026-1-1", 1);
    }).toThrow(TypeError);
  });
});
