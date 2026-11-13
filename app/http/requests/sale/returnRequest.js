// Shapes what a browser sends for a sales return into the plain input the return service validates.
import { rowsOf } from "../purchasing/purchasingRequest.js";

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

export function returnRequest(body) {
  return {
    reason: str(body?.reason),
    lines: rowsOf(body?.lines).map((row) => {
      return {
        saleItemBatchId: str(row.saleItemBatchId),
        quantity: str(row.quantity),
        disposition: str(row.disposition),
      };
    }),
  };
}

export function processRequest(body) {
  return { refundMethod: str(body?.refundMethod), referenceNumber: str(body?.referenceNumber) };
}

export function returnListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
