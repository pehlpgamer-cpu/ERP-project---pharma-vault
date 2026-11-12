// Business-time helpers. Data is stored in UTC; "today", date filters and day grouping follow the
// business time zone (APP_TIMEZONE, default Asia/Manila). One fixed UTC offset is used, which is
// correct for zones without daylight saving time.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

let cachedOffsetMinutes = null;

function assertDate(date) {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    throw new TypeError(`Expected a YYYY-MM-DD date, got ${String(date)}`);
  }
}

function dayStartUtc(date) {
  assertDate(date);

  return Date.parse(`${date}T00:00:00Z`);
}

export function businessTimeZone() {
  return process.env.APP_TIMEZONE || "Asia/Manila";
}

function offsetMinutesAt(zone, at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const read = (type) => {
    return Number(
      parts.find((part) => {
        return part.type === type;
      }).value,
    );
  };
  const localAsUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );

  return Math.round((localAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Minutes the business zone is ahead of UTC (480 for Asia/Manila), computed once. */
export function businessOffsetMinutes() {
  cachedOffsetMinutes ??= offsetMinutesAt(businessTimeZone(), new Date());

  return cachedOffsetMinutes;
}

/** The business-zone calendar date of an instant, as YYYY-MM-DD. */
export function businessDate(instant) {
  return new Date(instant.getTime() + businessOffsetMinutes() * 60_000).toISOString().slice(0, 10);
}

/** The UTC instant at which the business day `date` starts. */
export function startOfBusinessDay(date) {
  return new Date(dayStartUtc(date) - businessOffsetMinutes() * 60_000);
}

/** The exclusive upper bound for a range that ends on business day `date`. */
export function startOfNextBusinessDay(date) {
  return startOfBusinessDay(addDays(date, 1));
}

export function addDays(date, days) {
  return new Date(dayStartUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `from` to `to`, inclusive; empty when `from` is after `to`. */
export function eachDay(from, to) {
  assertDate(from);
  assertDate(to);

  const days = [];

  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }

  return days;
}

/** The UTC date parts of a Date (or the leading YYYY-MM-DD of a string); null when there is none. */
export function toDateString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));

  return match === null ? null : match[1];
}
