import { test } from "@japa/runner";
import {
  addLine,
  attemptFor,
  cartTotals,
  changeUnit,
  classifyOutcome,
  emptyCart,
  normalizeAmount,
  normalizeQuantity,
  prescriptionShortage,
  removeLine,
  restoreAttempt,
  restoreCart,
  setQuantity,
  stepQuantity,
  tenderSummary,
} from "../../public/js/pos-cart.js";
import { mul, toScale } from "../../app/services/support/decimal.js";

const STRIP = {
  productUnitId: "unit-strip",
  productId: "p-1",
  productName: "Paracetamol",
  unitName: "Strip",
  price: "30.0000",
};
const TABLET = { ...STRIP, productUnitId: "unit-tablet", unitName: "Tablet", price: "3.5000" };

const quantities = (cart) => {
  return cart.lines.map((line) => {
    return [line.productUnitId, line.quantity];
  });
};

test.group("cart lines", () => {
  test("adding the same unit twice merges into one line", ({ expect }) => {
    const cart = addLine(addLine(emptyCart(), STRIP), STRIP);

    expect(quantities(cart)).toEqual([["unit-strip", "2"]]);
  });

  test("different units of one product stay separate lines, in the order added", ({ expect }) => {
    const cart = addLine(addLine(emptyCart(), STRIP, "2"), TABLET, "5");

    expect(quantities(cart)).toEqual([
      ["unit-strip", "2"],
      ["unit-tablet", "5"],
    ]);
  });

  test("quantities add exactly, with decimals", ({ expect }) => {
    const cart = addLine(addLine(emptyCart(), STRIP, "1.5"), STRIP, "0.25");

    expect(quantities(cart)).toEqual([["unit-strip", "1.75"]]);
  });

  test("a unit without a price, or a quantity that is not positive, is not added", ({ expect }) => {
    const cart = emptyCart();

    expect(addLine(cart, { ...STRIP, price: null })).toBe(cart);
    expect(addLine(cart, STRIP, "0")).toBe(cart);
    expect(addLine(cart, STRIP, "-1")).toBe(cart);
    expect(addLine(cart, STRIP, "abc")).toBe(cart);
  });

  test("setQuantity replaces the quantity, removes the line at zero or below, ignores junk", ({
    expect,
  }) => {
    const cart = addLine(emptyCart(), STRIP, "2");

    expect(quantities(setQuantity(cart, "unit-strip", "5"))).toEqual([["unit-strip", "5"]]);
    expect(setQuantity(cart, "unit-strip", "0").lines).toEqual([]);
    expect(setQuantity(cart, "unit-strip", "-3").lines).toEqual([]);
    expect(setQuantity(cart, "unit-strip", "abc")).toBe(cart);
    expect(setQuantity(cart, "unit-strip", "1.2345")).toBe(cart);
    expect(setQuantity(cart, "no-such-unit", "4")).toBe(cart);
  });

  test("stepQuantity moves the quantity by one exactly and removes the line at zero", ({
    expect,
  }) => {
    const cart = addLine(emptyCart(), STRIP, "2.5");

    expect(quantities(stepQuantity(cart, "unit-strip", "1"))).toEqual([["unit-strip", "3.5"]]);
    expect(quantities(stepQuantity(cart, "unit-strip", "-1"))).toEqual([["unit-strip", "1.5"]]);
    expect(stepQuantity(addLine(emptyCart(), STRIP, "1"), "unit-strip", "-1").lines).toEqual([]);
    expect(stepQuantity(cart, "unit-strip", "x")).toBe(cart);
    expect(stepQuantity(cart, "unit-nope", "1")).toBe(cart);
  });

  test("removeLine drops only that line", ({ expect }) => {
    const cart = addLine(addLine(emptyCart(), STRIP), TABLET);

    expect(quantities(removeLine(cart, "unit-strip"))).toEqual([["unit-tablet", "1"]]);
  });

  test("changeUnit swaps the unit and keeps the quantity, merging into an existing line", ({
    expect,
  }) => {
    const cart = addLine(emptyCart(), STRIP, "2");
    const swapped = changeUnit(cart, "unit-strip", {
      productUnitId: "unit-tablet",
      unitName: "Tablet",
      price: "3.5000",
    });
    const merged = changeUnit(addLine(swapped, STRIP, "1"), "unit-strip", {
      productUnitId: "unit-tablet",
      unitName: "Tablet",
      price: "3.5000",
    });

    expect(swapped.lines).toMatchObject([
      { productUnitId: "unit-tablet", unitName: "Tablet", price: "3.5000", quantity: "2" },
    ]);
    expect(quantities(merged)).toEqual([["unit-tablet", "3"]]);
    expect(changeUnit(cart, "unit-strip", { productUnitId: "unit-tablet", price: null })).toBe(
      cart,
    );
  });

  test("the functions return new carts and never change the one they are given", ({ expect }) => {
    const cart = addLine(emptyCart(), STRIP, "2");
    const snapshot = JSON.stringify(cart);

    addLine(cart, STRIP);
    setQuantity(cart, "unit-strip", "9");
    removeLine(cart, "unit-strip");
    changeUnit(cart, "unit-strip", {
      productUnitId: "unit-tablet",
      unitName: "Tablet",
      price: "1",
    });

    expect(JSON.stringify(cart)).toBe(snapshot);
  });
});

test.group("totals", () => {
  test("2.5 strips at 30.00 are 75.00", ({ expect }) => {
    const cart = addLine(emptyCart(), STRIP, "2.5");

    expect(cartTotals(cart)).toEqual({
      lines: [{ productUnitId: "unit-strip", subtotal: "75.00" }],
      total: "75.00",
    });
  });

  test("an empty cart totals 0.00", ({ expect }) => {
    expect(cartTotals(emptyCart())).toEqual({ lines: [], total: "0.00" });
  });

  test("line subtotals are rounded half up and the total is their sum", ({ expect }) => {
    const cart = addLine(addLine(emptyCart(), TABLET, "0.333"), STRIP, "1");

    // 0.333 x 3.50 = 1.1655 -> 1.17, plus 30.00
    expect(cartTotals(cart).total).toBe("31.17");
  });

  test("matches the server's decimal rounding for the same quantity and price", ({ expect }) => {
    for (const [quantity, price] of [
      ["3", "19.9950"],
      ["0.333", "10.0000"],
      ["1.005", "1.0000"],
      ["2", "0.0050"],
      ["7.5", "2.3450"],
    ]) {
      const cart = addLine(emptyCart(), { ...STRIP, price }, quantity);

      expect([quantity, price, cartTotals(cart).total]).toEqual([
        quantity,
        price,
        toScale(mul(quantity, price), 2),
      ]);
    }
  });
});

test.group("tender", () => {
  test("cash over the total gives change", ({ expect }) => {
    expect(tenderSummary("180.00", [{ method: "CASH", amount: "200.00" }])).toEqual({
      tendered: "200.00",
      change: "20.00",
      remaining: "0.00",
      valid: true,
    });
  });

  test("an underpayment shows what is remaining and is not valid", ({ expect }) => {
    expect(tenderSummary("180.00", [{ method: "CASH", amount: "100" }])).toEqual({
      tendered: "100.00",
      change: "0.00",
      remaining: "80.00",
      valid: false,
    });
  });

  test("non-cash payments cannot be more than the total", ({ expect }) => {
    expect(tenderSummary("180.00", [{ method: "GCASH", amount: "200.00" }])).toMatchObject({
      tendered: "200.00",
      valid: false,
    });
    expect(
      tenderSummary("180.00", [
        { method: "GCASH", amount: "100.00" },
        { method: "CARD", amount: "100.00" },
      ]).valid,
    ).toBe(false);
  });

  test("a split of cash and an electronic payment is valid, with change out of the cash", ({
    expect,
  }) => {
    expect(
      tenderSummary("180.00", [
        { method: "CASH", amount: "150.00" },
        { method: "GCASH", amount: "100.00" },
      ]),
    ).toEqual({ tendered: "250.00", change: "70.00", remaining: "0.00", valid: true });
  });

  test("blank and invalid amounts count as zero", ({ expect }) => {
    expect(
      tenderSummary("10.00", [
        { method: "CASH", amount: "" },
        { method: "CASH", amount: "abc" },
      ]),
    ).toEqual({ tendered: "0.00", change: "0.00", remaining: "10.00", valid: false });
  });
});

test.group("input helpers and storage", () => {
  test("normalizeQuantity accepts positive numbers with at most 3 decimals", ({ expect }) => {
    expect(normalizeQuantity(" 2 ")).toBe("2");
    expect(normalizeQuantity("0.5")).toBe("0.5");
    expect(normalizeQuantity("1.250")).toBe("1.250");

    for (const bad of ["", "0", "-1", "abc", "1e3", "1.2345", "1,5", null, undefined, 2]) {
      expect([bad, normalizeQuantity(bad)]).toEqual([bad, null]);
    }
  });

  test("normalizeAmount accepts zero or more with at most 2 decimals", ({ expect }) => {
    expect(normalizeAmount("50")).toBe("50.00");
    expect(normalizeAmount("12.5")).toBe("12.50");
    expect(normalizeAmount("0")).toBe("0.00");

    for (const bad of ["", "-1", "abc", "1.234", "1e2", null, undefined]) {
      expect([bad, normalizeAmount(bad)]).toEqual([bad, null]);
    }
  });

  test("restoreCart rebuilds a saved cart and drops anything that is not a valid line", ({
    expect,
  }) => {
    const saved = JSON.parse(
      JSON.stringify(addLine(addLine(emptyCart(), STRIP, "2"), TABLET, "5")),
    );

    expect(restoreCart(saved)).toEqual(addLine(addLine(emptyCart(), STRIP, "2"), TABLET, "5"));
    expect(restoreCart(null)).toEqual(emptyCart());
    expect(restoreCart("junk")).toEqual(emptyCart());
    expect(restoreCart({ lines: "nope" })).toEqual(emptyCart());
    expect(
      restoreCart({
        lines: [
          { productUnitId: "ok", productName: "A", unitName: "U", price: "1.0000", quantity: "2" },
          {
            productUnitId: "bad-price",
            productName: "B",
            unitName: "U",
            price: "x",
            quantity: "1",
          },
          { productUnitId: "bad-qty", productName: "C", unitName: "U", price: "1", quantity: "0" },
          { productUnitId: 5, productName: "D", unitName: "U", price: "1", quantity: "1" },
          null,
        ],
      }).lines,
    ).toMatchObject([{ productUnitId: "ok", quantity: "2" }]);
  });
});

test.group("sale attempts (a lost answer must never become a second sale)", () => {
  const keyMaker = () => {
    let count = 0;

    return () => {
      count += 1;

      return `key-${count}`;
    };
  };

  test("the same sale keeps its key and a different sale gets a new one", ({ expect }) => {
    const makeKey = keyMaker();
    const first = attemptFor(null, '{"a":1}', makeKey);

    expect(first).toEqual({ key: "key-1", body: '{"a":1}', pending: false });
    expect(attemptFor(first, '{"a":1}', makeKey)).toBe(first);
    expect(attemptFor(first, '{"a":2}', makeKey)).toEqual({
      key: "key-2",
      body: '{"a":2}',
      pending: false,
    });
  });

  test("an attempt that got no answer is sent again exactly as it was, whatever the cart says now", ({
    expect,
  }) => {
    const makeKey = keyMaker();
    const pending = { key: "key-1", body: '{"a":1}', pending: true };

    expect(attemptFor(pending, '{"a":2}', makeKey)).toBe(pending);
    expect(attemptFor(pending, '{"a":1}', makeKey)).toBe(pending);
    expect(makeKey()).toBe("key-1");
  });

  test("only a 2xx is a saved sale and only a 4xx with an error body proves nothing was saved", ({
    expect,
  }) => {
    for (const [status, hasError, outcome] of [
      [201, false, "saved"],
      [200, false, "saved"],
      [401, true, "refused"],
      [409, true, "refused"],
      [422, true, "refused"],
      [400, false, "unknown"],
      [404, false, "unknown"],
      [500, true, "unknown"],
      [502, false, "unknown"],
      [503, true, "unknown"],
      [null, false, "unknown"],
      [undefined, true, "unknown"],
    ]) {
      expect([status, hasError, classifyOutcome(status, hasError)]).toEqual([
        status,
        hasError,
        outcome,
      ]);
    }
  });

  test("restoreAttempt brings back only a well-formed pending attempt", ({ expect }) => {
    const saved = { key: "key-1", body: '{"a":1}', pending: true };

    expect(restoreAttempt(JSON.parse(JSON.stringify(saved)))).toEqual(saved);

    for (const bad of [
      null,
      undefined,
      "junk",
      42,
      {},
      { key: "key-1", body: "{}", pending: false },
      { key: "key-1", body: "{}" },
      { key: 1, body: "{}", pending: true },
      { key: "key-1", body: 2, pending: true },
      { body: "{}", pending: true },
    ]) {
      expect([bad, restoreAttempt(bad)]).toEqual([bad, null]);
    }
  });

  test("prescriptionShortage names each product with what was asked and what is left", ({
    expect,
  }) => {
    const lines = [{ productId: "p-1", productName: "Amoxicillin" }];

    expect(
      prescriptionShortage(
        [
          { productId: "p-1", requested: "40.000", remaining: "30.000" },
          { productId: "p-9", requested: "2.000", remaining: "0.000" },
        ],
        lines,
      ),
    ).toBe(
      "Amoxicillin: 40 requested, 30 left on the prescription\nA product: 2 requested, none left on the prescription",
    );
    expect(prescriptionShortage([], lines)).toBe("");
  });
});
