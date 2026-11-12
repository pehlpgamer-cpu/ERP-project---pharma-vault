// Explicit key lists: a field only reaches the API when it is named here, so cost data, idempotency
// keys and customer contact details cannot leak by accident.

const iso = (value) => {
  return value instanceof Date ? value.toISOString() : (value ?? null);
};

/** One row of GET /sales. */
export function saleListResource(sale) {
  return {
    id: sale.id,
    invoiceNumber: sale.invoiceNumber,
    status: sale.status,
    transactionDate: iso(sale.transactionDate),
    branch: { id: sale.branch.id, code: sale.branch.code, name: sale.branch.name },
    cashier: { id: sale.cashier.id, name: sale.cashier.name },
    customer: sale.customer
      ? {
          id: sale.customer.id,
          customerNumber: sale.customer.customerNumber,
          name: sale.customer.name,
        }
      : null,
    register: { id: sale.register.id, code: sale.register.code, name: sale.register.name },
    itemCount: sale.itemCount,
    paymentMethods: [...sale.paymentMethods],
    totals: {
      subtotal: sale.totals.subtotal,
      discount: sale.totals.discount,
      tax: sale.totals.tax,
      total: sale.totals.total,
      paid: sale.totals.paid,
      change: sale.totals.change,
    },
  };
}

/** GET /sales/:id and the checkout response: the list row plus items and payments. */
export function saleDetailResource(sale) {
  return {
    ...saleListResource(sale),
    items: sale.items.map((item) => {
      return {
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        genericName: item.genericName,
        unit: { id: item.unit.id, name: item.unit.name, abbreviation: item.unit.abbreviation },
        quantity: item.quantity,
        baseQuantity: item.baseQuantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        tax: item.tax,
        subtotal: item.subtotal,
        total: item.total,
        batches: item.batches.map((batch) => {
          return {
            batchId: batch.batchId,
            batchNumber: batch.batchNumber,
            expirationDate: batch.expirationDate,
            quantity: batch.quantity,
          };
        }),
      };
    }),
    payments: sale.payments.map((payment) => {
      return {
        id: payment.id,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference,
        status: payment.status,
        paidAt: iso(payment.paidAt),
      };
    }),
  };
}
