// {{badge status}}: a colored chip with a readable label ("PARTIALLY_REFUNDED" -> "Partially refunded").
// Returns an object with toHTML(), which Handlebars prints as-is, so the text is escaped here.
const COLORS = {
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-800",
  red: "bg-red-100 text-red-800",
  gray: "bg-gray-100 text-gray-700",
};

const STATUS_COLORS = {
  COMPLETED: "green",
  PAID: "green",
  ACTIVE: "green",
  OPEN: "green",
  PENDING: "amber",
  RECONCILIATION_REQUIRED: "amber",
  REFUNDED: "blue",
  PARTIALLY_REFUNDED: "blue",
  VOIDED: "gray",
  QUARANTINED: "amber",
  RECALLED: "red",
  FAILED: "red",
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  SENT: "blue",
  PARTIALLY_RECEIVED: "amber",
  FULLY_RECEIVED: "green",
  POSTED: "green",
  CANCELLED: "red",
  REJECTED: "red",
};

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const escape = (text) => {
  return String(text).replace(/[&<>"']/g, (character) => {
    return ENTITIES[character];
  });
};

const label = (status) => {
  const text = String(status).replace(/_/g, " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

export default function badge(status) {
  const classes = COLORS[STATUS_COLORS[status] ?? "gray"];

  return {
    toHTML() {
      return `<span class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${classes}">${escape(label(status))}</span>`;
    },
  };
}
