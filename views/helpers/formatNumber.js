// {{formatNumber baseQuantity}}: "20.000" -> "20", "1234.5" -> "1,234.5". Display only.
// An optional maximum number of decimals may follow (default 3).
export default function formatNumber(value, maxDigits) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "";
  }

  return new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: typeof maxDigits === "number" ? maxDigits : 3,
  }).format(number);
}
