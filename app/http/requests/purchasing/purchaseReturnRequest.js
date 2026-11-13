// Shapes what a browser sends for a supplier return into the plain input the service validates.
import { rowsOf } from "./purchasingRequest.js";

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

export function purchaseReturnRequest(body) {
  return {
    supplierId: str(body?.supplierId),
    reason: str(body?.reason),
    lines: rowsOf(body?.lines).map((row) => {
      return { inventoryBatchId: str(row.inventoryBatchId), quantity: str(row.quantity) };
    }),
  };
}

export function purchaseReturnListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
