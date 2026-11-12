import { businessTimeZone } from "../../app/services/support/time.js";

// {{formatDate transactionDate}} -> "Nov 13, 2026" in the business time zone.
// An optional style (full | long | medium | short) may follow: {{formatDate value "short"}}.
export default function formatDate(value, style) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: typeof style === "string" ? style : "medium",
    timeZone: businessTimeZone(),
  }).format(date);
}
