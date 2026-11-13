// Shapes what a browser sends for stock transfers into the plain input the transfer service validates.
import { rowsOf } from "../purchasing/purchasingRequest.js";

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

export function transferRequest(body) {
  return {
    sourceBranchId: str(body?.sourceBranchId),
    lines: rowsOf(body?.lines).map((row) => {
      return { sourceBatchId: str(row.sourceBatchId), quantity: str(row.quantity) };
    }),
  };
}

// dispatch and receive forms: `lines[i][itemId]` and `lines[i][quantity]`
export function quantitiesRequest(body) {
  return {
    lines: rowsOf(body?.lines).map((row) => {
      return { itemId: str(row.itemId), quantity: str(row.quantity) };
    }),
  };
}

export function transferListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
