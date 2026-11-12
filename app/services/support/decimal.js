// Exact decimal arithmetic on strings, backed by BigInt. Money and quantities never touch floats.
// Inputs are decimal strings or safe integers; every result is a string.

const PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

function pow10(exponent) {
  return 10n ** BigInt(exponent);
}

// value = int / 10^scale
function parse(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Expected a decimal string or an integer, got ${value}`);
    }

    return { int: BigInt(value), scale: 0 };
  }

  const match = typeof value === "string" ? PATTERN.exec(value) : null;

  if (match === null) {
    throw new TypeError(`Invalid decimal: ${String(value)}`);
  }

  const [, sign, whole, fraction = ""] = match;
  const int = BigInt(whole + fraction);

  return { int: sign === "-" ? -int : int, scale: fraction.length };
}

function format({ int, scale }) {
  const negative = int < 0n;
  const digits = (negative ? -int : int).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";

  return `${negative ? "-" : ""}${whole}${fraction}`;
}

// Integer division rounded half away from zero.
function roundDivide(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const magnitude = denominator < 0n ? -denominator : denominator;

  if (doubled >= magnitude) {
    return quotient + (numerator < 0n !== denominator < 0n ? -1n : 1n);
  }

  return quotient;
}

// The integer for `parsed` at `target` decimal places (rounding only when `target` is smaller).
function rescale({ int, scale }, target) {
  if (target >= scale) {
    return int * pow10(target - scale);
  }

  return roundDivide(int, pow10(scale - target));
}

/** Rounds half away from zero to `scale` places and zero-pads. */
export function toScale(value, scale) {
  return format({ int: rescale(parse(value), scale), scale });
}

export function add(a, b) {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);

  return format({ int: rescale(x, scale) + rescale(y, scale), scale });
}

export function sub(a, b) {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);

  return format({ int: rescale(x, scale) - rescale(y, scale), scale });
}

/** Exact product; the result keeps the sum of both scales. */
export function mul(a, b) {
  const x = parse(a);
  const y = parse(b);

  return format({ int: x.int * y.int, scale: x.scale + y.scale });
}

/** Quotient rounded half away from zero to `scale` places. Throws RangeError on a zero divisor. */
export function div(a, b, scale) {
  const x = parse(a);
  const y = parse(b);

  if (y.int === 0n) {
    throw new RangeError("Division by zero");
  }

  const numerator = x.int * pow10(y.scale + scale);
  const denominator = y.int * pow10(x.scale);

  return format({ int: roundDivide(numerator, denominator), scale });
}

export function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const left = rescale(x, scale);
  const right = rescale(y, scale);

  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

export function sum(values) {
  return values.reduce((total, value) => {
    return add(total, value);
  }, "0");
}

/** The smaller input, returned exactly as given. */
export function min(a, b) {
  return cmp(a, b) <= 0 ? a : b;
}

export function isDecimal(value) {
  return typeof value === "string" && PATTERN.test(value);
}
