import { test } from "@japa/runner";
import {
  add,
  cmp,
  div,
  isDecimal,
  min,
  mul,
  sub,
  sum,
  toScale,
} from "../../app/services/support/decimal.js";

test.group("decimal", () => {
  test("add is exact", ({ expect }) => {
    expect(add("0.10", "0.20")).toBe("0.30");
    expect(add("1", "0.005")).toBe("1.005");
  });

  test("sub handles negatives", ({ expect }) => {
    expect(sub("1.00", "2.50")).toBe("-1.50");
  });

  test("mul is exact and sums the scales", ({ expect }) => {
    expect(mul("2.000", "30.0000")).toBe("60.0000000");
    expect(mul("-2", "3.5")).toBe("-7.0");
  });

  test("toScale rounds half away from zero and pads", ({ expect }) => {
    expect(toScale("1.005", 2)).toBe("1.01");
    expect(toScale("-1.005", 2)).toBe("-1.01");
    expect(toScale("12.345", 2)).toBe("12.35");
    expect(toScale("2", 3)).toBe("2.000");
    expect(toScale(5, 2)).toBe("5.00");
  });

  test("toScale never prints a negative zero", ({ expect }) => {
    expect(toScale("-0.004", 2)).toBe("0.00");
  });

  test("toScale rejects floats and non-numbers", ({ expect }) => {
    expect(() => {
      return toScale(1.5, 2);
    }).toThrow(TypeError);
    expect(() => {
      return toScale("abc", 2);
    }).toThrow(TypeError);
  });

  test("div rounds to the requested scale", ({ expect }) => {
    expect(div("100", "3", 4)).toBe("33.3333");
    expect(div("2", "3", 2)).toBe("0.67");
    expect(div("-2", "3", 2)).toBe("-0.67");
  });

  test("div by zero throws RangeError", ({ expect }) => {
    expect(() => {
      return div("1", "0", 2);
    }).toThrow(RangeError);
  });

  test("cmp compares across scales", ({ expect }) => {
    expect(cmp("2.0", "2.00")).toBe(0);
    expect(cmp("-1", "1")).toBe(-1);
    expect(cmp("1.001", "1")).toBe(1);
  });

  test("sum adds a list exactly", ({ expect }) => {
    expect(sum([])).toBe("0");
    expect(sum(["0.10", "0.20", "0.30"])).toBe("0.60");
  });

  test("min returns the smaller input unchanged", ({ expect }) => {
    expect(min("2.00", "3")).toBe("2.00");
    expect(min("3", "2.00")).toBe("2.00");
  });

  test("isDecimal accepts plain decimal strings only", ({ expect }) => {
    expect(isDecimal("1e3")).toBe(false);
    expect(isDecimal("-1.50")).toBe(true);
    expect(isDecimal("")).toBe(false);
    expect(isDecimal(5)).toBe(false);
  });
});
