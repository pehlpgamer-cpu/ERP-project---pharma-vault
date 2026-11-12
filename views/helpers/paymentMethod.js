// {{paymentMethod method}}: "BANK_TRANSFER" -> "Bank transfer", "GCASH" -> "GCash".
const LABELS = {
  CASH: "Cash",
  CARD: "Card",
  GCASH: "GCash",
  MAYA: "Maya",
  BANK_TRANSFER: "Bank transfer",
  OTHER: "Other",
};

export default function paymentMethod(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (LABELS[value]) {
    return LABELS[value];
  }

  const text = String(value).replace(/_/g, " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
}
