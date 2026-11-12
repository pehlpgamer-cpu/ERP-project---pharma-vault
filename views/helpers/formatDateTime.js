import { businessTimeZone } from "../../app/services/support/time.js";

// {{formatDateTime transactionDate}} -> "Nov 13, 2026, 12:00 AM" in the business time zone.
export default function formatDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: businessTimeZone(),
  }).format(date);
}
