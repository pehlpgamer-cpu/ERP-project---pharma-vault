// POS cart logic: plain functions on plain objects, no DOM and no imports. Money and quantities are
// exact decimal strings (BigInt) so the screen agrees with the server, which still recomputes every
// figure. Every function returns a new cart and leaves the one it was given untouched.

const PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;
const ZERO = { int: 0n, scale: 0 };

// "12.50" -> { int: 1250n, scale: 2 }; null when the text is not a plain decimal.
function parse(value) {
  const match = typeof value === "string" ? PATTERN.exec(value.trim()) : null;

  if (match === null) {
    return null;
  }

  const [, sign, whole, fraction = ""] = match;
  const int = BigInt(whole + fraction);

  return { int: sign === "-" ? -int : int, scale: fraction.length };
}

function format({ int, scale }) {
  const negative = int < 0n;
  const digits = (negative ? -int : int).toString().padStart(scale + 1, "0");
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";

  return `${negative ? "-" : ""}${digits.slice(0, digits.length - scale)}${fraction}`;
}

// The integer of `value` at `target` decimal places, rounding half away from zero.
function rescale({ int, scale }, target) {
  if (target >= scale) {
    return int * 10n ** BigInt(target - scale);
  }

  const divisor = 10n ** BigInt(scale - target);
  const quotient = int / divisor;
  const remainder = int % divisor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;

  if (twice >= divisor) {
    return quotient + (int < 0n ? -1n : 1n);
  }

  return quotient;
}

function toScale(value, scale) {
  return format({ int: rescale(value, scale), scale });
}

function plus(x, y) {
  const scale = Math.max(x.scale, y.scale);

  return { int: rescale(x, scale) + rescale(y, scale), scale };
}

function minus(x, y) {
  return plus(x, { int: -y.int, scale: y.scale });
}

function times(x, y) {
  return { int: x.int * y.int, scale: x.scale + y.scale };
}

function isAtMost(x, y) {
  return minus(x, y).int <= 0n;
}

/** A quantity as the cashier typed it: more than zero, at most 3 decimals. Null when it is not one. */
export function normalizeQuantity(text) {
  const value = parse(text);

  if (value === null || value.int <= 0n || value.scale > 3) {
    return null;
  }

  return format(value);
}

/** An amount of money: zero or more, at most 2 decimals, given back with exactly 2. Null otherwise. */
export function normalizeAmount(text) {
  const value = parse(text);

  if (value === null || value.int < 0n || value.scale > 2) {
    return null;
  }

  return toScale(value, 2);
}

export function emptyCart() {
  return { lines: [] };
}

const findLine = (cart, productUnitId) => {
  return cart.lines.find((line) => {
    return line.productUnitId === productUnitId;
  });
};

const replaceLine = (cart, target, replacement) => {
  return {
    lines: cart.lines.map((line) => {
      return line === target ? replacement : line;
    }),
  };
};

/**
 * Adds `quantity` of a unit. `info` is { productUnitId, productId, productName, unitName, price,
 * units } where `price` is the unit price as a decimal string and `units` lists the product's other
 * units for the unit selector. The same unit merges into its existing line; a unit without a price
 * or a quantity that is not positive changes nothing.
 */
export function addLine(cart, info, quantity = "1") {
  const amount = normalizeQuantity(quantity);

  if (amount === null || parse(info.price) === null) {
    return cart;
  }

  const existing = findLine(cart, info.productUnitId);

  if (existing !== undefined) {
    const merged = format(plus(parse(existing.quantity), parse(amount)));

    return replaceLine(cart, existing, { ...existing, quantity: merged });
  }

  return {
    lines: [
      ...cart.lines,
      {
        productUnitId: info.productUnitId,
        productId: info.productId ?? null,
        productName: info.productName,
        unitName: info.unitName,
        price: info.price,
        units: info.units ?? [],
        quantity: amount,
      },
    ],
  };
}

export function removeLine(cart, productUnitId) {
  return {
    lines: cart.lines.filter((line) => {
      return line.productUnitId !== productUnitId;
    }),
  };
}

/** Sets a line's quantity: zero or below removes the line, text that is not a quantity changes nothing. */
export function setQuantity(cart, productUnitId, quantity) {
  const line = findLine(cart, productUnitId);
  const value = parse(quantity);

  if (line === undefined || value === null || value.scale > 3) {
    return cart;
  }

  if (value.int <= 0n) {
    return removeLine(cart, productUnitId);
  }

  return replaceLine(cart, line, { ...line, quantity: format(value) });
}

/** Moves a line's quantity up or down by `delta` ("1" or "-1"); reaching zero removes the line. */
export function stepQuantity(cart, productUnitId, delta) {
  const line = findLine(cart, productUnitId);
  const step = parse(delta);

  if (line === undefined || step === null) {
    return cart;
  }

  return setQuantity(cart, productUnitId, format(plus(parse(line.quantity), step)));
}

/**
 * Sells a line in another unit of the same product (the quantity stays). `to` is { productUnitId,
 * unitName, price }; a line already in that unit absorbs this one.
 */
export function changeUnit(cart, fromUnitId, to) {
  const line = findLine(cart, fromUnitId);

  if (line === undefined || parse(to.price) === null || to.productUnitId === fromUnitId) {
    return cart;
  }

  const target = findLine(cart, to.productUnitId);

  if (target !== undefined) {
    const merged = format(plus(parse(target.quantity), parse(line.quantity)));

    return replaceLine(removeLine(cart, fromUnitId), target, { ...target, quantity: merged });
  }

  return replaceLine(cart, line, {
    ...line,
    productUnitId: to.productUnitId,
    unitName: to.unitName,
    price: to.price,
  });
}

/** Line subtotals and the total, as 2-place strings rounded half up. */
export function cartTotals(cart) {
  const lines = cart.lines.map((line) => {
    const subtotal = times(parse(line.quantity), parse(line.price));

    return { productUnitId: line.productUnitId, subtotal: toScale(subtotal, 2) };
  });
  const total = lines.reduce((sum, line) => {
    return plus(sum, parse(line.subtotal));
  }, parse("0.00"));

  return { lines, total: toScale(total, 2) };
}

/**
 * What the payments add up to against the total. `valid` means the payments cover the total and the
 * non-cash part does not exceed it, so any change comes out of the cash.
 */
export function tenderSummary(total, payments) {
  const due = parse(total) ?? ZERO;
  let tendered = ZERO;
  let nonCash = ZERO;

  for (const payment of payments) {
    const amount = parse(normalizeAmount(payment.amount) ?? "0.00");

    tendered = plus(tendered, amount);

    if (payment.method !== "CASH") {
      nonCash = plus(nonCash, amount);
    }
  }

  const difference = minus(tendered, due);
  const covered = difference.int >= 0n;

  return {
    tendered: toScale(tendered, 2),
    change: covered ? toScale(difference, 2) : "0.00",
    remaining: covered ? "0.00" : toScale({ int: -difference.int, scale: difference.scale }, 2),
    valid: covered && isAtMost(nonCash, due),
  };
}

const isText = (value) => {
  return typeof value === "string";
};

/** A cart read back from storage: lines that are not valid are dropped, the rest rebuilt through addLine. */
export function restoreCart(data) {
  if (data === null || typeof data !== "object" || !Array.isArray(data.lines)) {
    return emptyCart();
  }

  let cart = emptyCart();

  for (const line of data.lines) {
    if (
      line === null ||
      typeof line !== "object" ||
      !isText(line.productUnitId) ||
      !isText(line.productName) ||
      !isText(line.unitName)
    ) {
      continue;
    }

    const units = (Array.isArray(line.units) ? line.units : [])
      .filter((unit) => {
        return (
          unit !== null &&
          typeof unit === "object" &&
          isText(unit.productUnitId) &&
          isText(unit.name)
        );
      })
      .map((unit) => {
        return {
          productUnitId: unit.productUnitId,
          name: unit.name,
          price: isText(unit.price) ? unit.price : null,
        };
      });

    cart = addLine(
      cart,
      {
        productUnitId: line.productUnitId,
        productId: isText(line.productId) ? line.productId : null,
        productName: line.productName,
        unitName: line.unitName,
        price: line.price,
        units,
      },
      line.quantity,
    );
  }

  return cart;
}

/**
 * The attempt to send for the sale whose request body is `body` (JSON text). An attempt that got no
 * definite answer (`pending`) may already be saved on the server, so it is sent again exactly as it
 * was, with the same key: the server then answers with that sale instead of making a second one.
 * Otherwise the same body keeps its key and a different body gets a new one.
 */
export function attemptFor(attempt, body, makeKey) {
  if (attempt !== null && (attempt.pending || attempt.body === body)) {
    return attempt;
  }

  return { key: makeKey(), body, pending: false };
}

/**
 * What an answer to the checkout request proves. "saved": a 2xx. "refused": a 4xx that carries an
 * error body, so the server looked at the request and saved nothing. "unknown": anything else (no
 * answer at all, a server error, a proxy page): the sale may or may not exist.
 */
export function classifyOutcome(status, hasError) {
  if (typeof status !== "number") {
    return "unknown";
  }

  if (status >= 200 && status < 300) {
    return "saved";
  }

  return status >= 400 && status < 500 && hasError ? "refused" : "unknown";
}

/** A pending attempt read back from storage, or null when what was stored is anything else. */
export function restoreAttempt(data) {
  if (
    data === null ||
    typeof data !== "object" ||
    !isText(data.key) ||
    !isText(data.body) ||
    data.pending !== true
  ) {
    return null;
  }

  return { key: data.key, body: data.body, pending: true };
}
