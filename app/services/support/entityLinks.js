// The page that shows a document, by the entity or reference type the services record in the audit
// log and the movement ledger. Types without a page of their own have no link.
const PAGES = {
  sale: "/sales",
  sales_return: "/returns",
  stock_transfer: "/transfers",
  prescription: "/prescriptions",
  inventory_adjustment: "/stock-counts",
  purchase_order: "/purchase-orders",
};

/** `/sales/<id>` and so on, or null when the type has no page or there is no id. */
export function entityLink(type, id) {
  if (!id || !Object.hasOwn(PAGES, type)) {
    return null;
  }

  return `${PAGES[type]}/${id}`;
}
