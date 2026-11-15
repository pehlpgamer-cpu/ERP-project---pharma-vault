// Shapes what a browser sends into the plain input the purchasing services validate. Only known
// keys are read and only strings are kept, so a crafted body cannot smuggle anything else in.

// generous: the services enforce the real limits and refuse more instead of dropping rows
const MAX_ROWS = 250;

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

const pick = (source, keys) => {
  const picked = {};

  for (const key of keys) {
    picked[key] = str(source?.[key]);
  }

  return picked;
};

// Express turns lines[0][x] into an array, or an object keyed by index when indexes are sparse.
export function rowsOf(value) {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort((a, b) => {
            return Number(a) - Number(b);
          })
          .map((key) => {
            return value[key];
          })
      : [];

  return list.slice(0, MAX_ROWS).map((row) => {
    return row && typeof row === "object" ? row : {};
  });
}

const flag = (value) => {
  return value === "on" || value === "1" || value === "true" || value === true;
};

export function supplierRequest(body) {
  return {
    ...pick(body, [
      "code",
      "name",
      "contactName",
      "phone",
      "email",
      "taxId",
      "paymentTerms",
      "address",
    ]),
    isActive: flag(body?.isActive),
  };
}

export function supplierListRequest(query) {
  const active = str(query?.active);

  return {
    q: str(query?.q)?.slice(0, 100),
    active: active === "yes" ? true : active === "no" ? false : undefined,
  };
}

export function orderRequest(body) {
  return {
    ...pick(body, ["supplierId", "expectedDate", "notes"]),
    lines: rowsOf(body?.lines).map((row) => {
      return pick(row, ["productUnitId", "quantity", "unitCost"]);
    }),
  };
}

export function orderListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function reasonRequest(body) {
  return { reason: str(body?.reason) };
}

export function receiptRequest(body) {
  return {
    ...pick(body, ["supplierInvoiceNumber", "notes"]),
    lines: rowsOf(body?.lines).map((row) => {
      return pick(row, [
        "purchaseOrderItemId",
        "batchNumber",
        "manufacturingDate",
        "expirationDate",
        "quantityAccepted",
        "quantityRejected",
        "rejectionReason",
      ]);
    }),
  };
}

/** A `{ path: message }` map (first message per path) for showing field errors beside the inputs. */
export function errorMap(details) {
  const map = {};

  for (const { path, message } of details) {
    map[path] ??= message;
  }

  return map;
}
