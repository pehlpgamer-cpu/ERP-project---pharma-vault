// {{currency value}}: pesos with two decimals; {{currency unitCost 4}} keeps four for unit costs.
export default function currency(value, digits) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "";
  }

  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    ...(typeof digits === "number"
      ? { minimumFractionDigits: digits, maximumFractionDigits: digits }
      : {}),
  }).format(amount);
}
