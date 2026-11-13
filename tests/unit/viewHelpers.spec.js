import { test } from "@japa/runner";
import and from "../../views/helpers/and.js";
import badge from "../../views/helpers/badge.js";
import can from "../../views/helpers/can.js";
import concat from "../../views/helpers/concat.js";
import currency from "../../views/helpers/currency.js";
import eq from "../../views/helpers/eq.js";
import formatDate from "../../views/helpers/formatDate.js";
import formatDateTime from "../../views/helpers/formatDateTime.js";
import formatNumber from "../../views/helpers/formatNumber.js";
import gt from "../../views/helpers/gt.js";
import isActive from "../../views/helpers/isActive.js";
import not from "../../views/helpers/not.js";
import or from "../../views/helpers/or.js";
import paymentMethod from "../../views/helpers/paymentMethod.js";

// Handlebars always passes its options object as the last argument.
const options = (permissions) => {
  return { data: { root: { currentUser: permissions ? { permissions } : null } } };
};

test.group("logic helpers", () => {
  test("eq is strict equality", ({ expect }) => {
    expect(eq(1, 1)).toBe(true);
    expect(eq(1, "1")).toBe(false);
  });

  test("gt compares numerically", ({ expect }) => {
    expect(gt("2", "1")).toBe(true);
    expect(gt(1, 2)).toBe(false);
  });

  test("and, or and not ignore the trailing options argument", ({ expect }) => {
    expect(and(true, 0, {})).toBe(false);
    expect(and(true, 1, {})).toBe(true);
    expect(or(0, "x", {})).toBe(true);
    expect(or(0, "", {})).toBe(false);
    expect(not(0)).toBe(true);
    expect(not("x")).toBe(false);
  });

  test("can is any-of over the signed-in user's permissions", ({ expect }) => {
    expect(can("a", "b", options(["b"]))).toBe(true);
    expect(can("a", options(["b"]))).toBe(false);
    expect(can("a", options(null))).toBe(false);
  });

  test("isActive matches the prefix itself or a sub-path", ({ expect }) => {
    expect(isActive("/sales", "/sales")).toBe(true);
    expect(isActive("/sales/123", "/sales")).toBe(true);
    expect(isActive("/salesx", "/sales")).toBe(false);
    expect(isActive(undefined, "/sales")).toBe(false);
  });
});

test.group("format helpers", () => {
  test("formatDate uses the business time zone", ({ expect }) => {
    expect(formatDate(new Date("2026-11-12T16:00:00Z"))).toBe("Nov 13, 2026");
    expect(formatDate(new Date("2026-11-12T15:59:59Z"))).toBe("Nov 12, 2026");
  });

  test("formatDate and formatDateTime print nothing for missing or invalid input", ({ expect }) => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("junk")).toBe("");
    expect(formatDateTime(undefined)).toBe("");
  });

  test("formatDateTime adds the time of day", ({ expect }) => {
    const text = formatDateTime(new Date("2026-11-12T16:00:00Z"));

    expect(text).toContain("Nov 13, 2026");
    expect(text).toMatch(/12:00/);
  });

  test("formatNumber trims trailing zeros and groups thousands", ({ expect }) => {
    expect(formatNumber("20.000")).toBe("20");
    expect(formatNumber("1.500")).toBe("1.5");
    expect(formatNumber("1234.5")).toBe("1,234.5");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(null)).toBe("");
    expect(formatNumber("")).toBe("");
  });
});

test.group("text helpers", () => {
  test("concat joins its arguments and drops the trailing options argument", ({ expect }) => {
    expect(concat("Yesterday ", "₱10.00", {})).toBe("Yesterday ₱10.00");
    expect(concat(14, " in the last 14 days", {})).toBe("14 in the last 14 days");
    expect(concat({})).toBe("");
  });

  test("paymentMethod gives each method its customer-facing label", ({ expect }) => {
    expect(paymentMethod("CASH")).toBe("Cash");
    expect(paymentMethod("GCASH")).toBe("GCash");
    expect(paymentMethod("BANK_TRANSFER")).toBe("Bank transfer");
  });

  test("paymentMethod reads an unknown method as words and prints nothing for no method", ({
    expect,
  }) => {
    expect(paymentMethod("STORE_CREDIT")).toBe("Store credit");
    expect(paymentMethod(null)).toBe("");
    expect(paymentMethod(undefined)).toBe("");
    expect(paymentMethod("")).toBe("");
  });
});

test.group("badge", () => {
  test("escapes the status text", ({ expect }) => {
    const html = badge("<b>").toHTML();

    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  test("colors follow the status and the label is readable", ({ expect }) => {
    expect(badge("COMPLETED").toHTML()).toContain("bg-green-100");
    expect(badge("COMPLETED").toHTML()).toContain("Completed");
    expect(badge("PENDING").toHTML()).toContain("bg-amber-100");
    expect(badge("PARTIALLY_REFUNDED").toHTML()).toContain("Partially refunded");
    expect(badge("FAILED").toHTML()).toContain("bg-red-100");
    expect(badge("SOMETHING_ELSE").toHTML()).toContain("bg-gray-100");
  });

  test("currency can keep more decimals for unit costs", ({ expect }) => {
    expect(currency("2", 4)).toBe("₱2.0000");
    expect(currency("0.125", 4)).toBe("₱0.1250");
    expect(currency("2")).toBe("₱2.00");
  });
});
