// Shapes what a browser sends for a stock count into the plain input the adjustment service validates.
import { rowsOf } from "../purchasing/purchasingRequest.js";

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

export function countRequest(body) {
  return {
    reason: str(body?.reason),
    lines: rowsOf(body?.lines).map((row) => {
      return {
        inventoryBatchId: str(row.inventoryBatchId),
        countedQuantity: str(row.countedQuantity),
      };
    }),
  };
}

export function countListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
