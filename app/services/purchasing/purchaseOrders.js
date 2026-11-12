// Purchase orders: a draft is written and edited, then walks submit → approve → send. Receiving
// (receiving.js) moves a sent order to partly or fully received. Every move locks the order row,
// re-checks the state under that lock, and is audited in the same transaction, so two clicks at
// once cannot both win. Actions stay in the actor's own branch; the all-branch scope may read.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { branches } from "../../models/branches.js";
import { productUnits } from "../../models/product-units.js";
import { products } from "../../models/products.js";
import { purchaseOrderItems } from "../../models/purchase-order-items.js";
import { purchaseOrders } from "../../models/purchase-orders.js";
import { suppliers } from "../../models/suppliers.js";
import { units } from "../../models/units.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { add, cmp, mul, toScale } from "../support/decimal.js";
import { isUuid } from "../support/ids.js";
import { businessDate, toDateString } from "../support/time.js";
import { nextDocumentNumber } from "./numbers.js";

const MAX_LINES = 100;
const MAX_NOTES = 2000;
const MAX_REASON = 500;
const PAGE_SIZE = 25;
const STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT",
  "PARTIALLY_RECEIVED",
  "FULLY_RECEIVED",
  "CLOSED",
  "CANCELLED",
];
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;
const COST = /^\d{1,10}(\.\d{1,4})?$/;

const notFound = () => {
  return new HttpError(404, "not_found", "Purchase order not found");
};

const wrongState = (message) => {
  return new HttpError(409, "po_state", message);
};

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

const lineError = (errors, index, field, message) => {
  errors.push({ path: `lines.${index}.${field}`, message, order: index });
};

// ---- reading and checking what is sent ----

/** Checks the header and lines of a draft against the catalog. Returns rows ready to insert. */
async function checkDraft(executor, input) {
  const errors = [];
  const supplierId = input?.supplierId;
  const notes = typeof input?.notes === "string" ? input.notes.trim() : "";
  const expected = input?.expectedDate;
  const rawLines = Array.isArray(input?.lines) ? input.lines : [];
  let expectedDate = null;

  if (isUuid(supplierId)) {
    const [supplier] = await executor.select().from(suppliers).where(eq(suppliers.id, supplierId));

    if (!supplier || !supplier.isActive) {
      errors.push({ path: "supplierId", message: "Choose an active supplier", order: -1 });
    }
  } else {
    errors.push({ path: "supplierId", message: "Choose a supplier", order: -1 });
  }

  if (notes.length > MAX_NOTES) {
    errors.push({ path: "notes", message: `Notes are at most ${MAX_NOTES} characters`, order: -1 });
  }

  if (expected !== undefined && expected !== null && expected !== "") {
    expectedDate = toDateString(expected);

    if (expectedDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(String(expected).slice(0, 10))) {
      errors.push({ path: "expectedDate", message: "Enter a valid date", order: -1 });
    }
  }

  if (rawLines.length === 0 || rawLines.length > MAX_LINES) {
    errors.push({
      path: "lines",
      message: `Add 1 to ${MAX_LINES} lines`,
      order: -1,
    });
  }

  const lines = rawLines.slice(0, MAX_LINES).map((line, index) => {
    const row = { index, productUnitId: line?.productUnitId };
    const quantity = typeof line?.quantity === "string" ? line.quantity.trim() : line?.quantity;
    const cost = typeof line?.unitCost === "string" ? line.unitCost.trim() : line?.unitCost;

    if (!isUuid(row.productUnitId)) {
      lineError(errors, index, "productUnitId", "Choose a product and unit");
    }

    if (typeof quantity !== "string" || !QUANTITY.test(quantity) || cmp(quantity, "0") <= 0) {
      lineError(errors, index, "quantity", "Enter a quantity above 0 (up to 3 decimals)");
    } else {
      row.quantity = toScale(quantity, 3);
    }

    if (typeof cost !== "string" || !COST.test(cost)) {
      lineError(errors, index, "unitCost", "Enter a cost of 0 or more (up to 4 decimals)");
    } else {
      row.unitCost = toScale(cost, 4);
    }

    return row;
  });

  const wanted = lines
    .filter((line) => {
      return isUuid(line.productUnitId);
    })
    .map((line) => {
      return line.productUnitId;
    });
  const found = wanted.length
    ? await executor
        .select({
          id: productUnits.id,
          productId: productUnits.productId,
          factor: productUnits.conversionFactor,
          canBePurchased: productUnits.canBePurchased,
          unitActive: productUnits.isActive,
          productActive: products.isActive,
        })
        .from(productUnits)
        .innerJoin(products, eq(products.id, productUnits.productId))
        .where(inArray(productUnits.id, wanted))
    : [];
  const byId = new Map(
    found.map((row) => {
      return [row.id, row];
    }),
  );
  const seen = new Set();

  for (const line of lines) {
    if (!isUuid(line.productUnitId)) {
      continue;
    }

    const unit = byId.get(line.productUnitId);

    if (!unit || !unit.canBePurchased || !unit.unitActive || !unit.productActive) {
      lineError(errors, line.index, "productUnitId", "This product unit cannot be purchased");
    } else if (seen.has(line.productUnitId)) {
      lineError(errors, line.index, "productUnitId", "This product unit is already on the order");
    } else {
      seen.add(line.productUnitId);
      line.productId = unit.productId;
      line.conversionFactor = unit.factor;
    }
  }

  if (errors.length > 0) {
    // header problems first, then by line; the order field only sorts and is not shown
    throw new ValidationError(
      errors
        .map((error, position) => {
          return { ...error, position };
        })
        .sort((a, b) => {
          return a.order - b.order || a.position - b.position;
        })
        .map(({ path, message }) => {
          return { path, message };
        }),
    );
  }

  const rows = lines.map((line) => {
    return { ...line, lineTotal: toScale(mul(line.quantity, line.unitCost), 2) };
  });

  return {
    supplierId,
    notes: notes === "" ? null : notes,
    expectedDate,
    rows,
    total: toScale(
      rows.reduce((total, row) => {
        return add(total, row.lineTotal);
      }, "0"),
      2,
    ),
  };
}

function cleanReason(input, required) {
  const text = typeof input?.reason === "string" ? input.reason.trim() : "";

  if ((required && text === "") || text.length > MAX_REASON) {
    throw new ValidationError([
      { path: "reason", message: `Give a reason of 1 to ${MAX_REASON} characters` },
    ]);
  }

  return text === "" ? null : text;
}

const lineRows = (orderId, rows) => {
  return rows.map((row) => {
    return {
      id: randomUUID(),
      purchaseOrderId: orderId,
      productId: row.productId,
      productUnitId: row.productUnitId,
      conversionFactor: row.conversionFactor,
      quantityOrdered: row.quantity,
      unitCost: row.unitCost,
      lineTotal: row.lineTotal,
    };
  });
};

// ---- writing ----

/** A new DRAFT in the actor's branch. Returns { id, poNumber }. */
export async function createPurchaseOrder(user, input, { now = new Date(), meta = {} } = {}) {
  if (!user.branchId) {
    throw forbidden("Purchase orders belong to a branch, and this account has none");
  }

  return await db.transaction(
    async (tx) => {
      const draft = await checkDraft(tx, input);
      const id = randomUUID();
      const poNumber = await nextDocumentNumber(tx, "PO", user.branchCode, businessDate(now));

      await tx.insert(purchaseOrders).values({
        id,
        poNumber,
        branchId: user.branchId,
        supplierId: draft.supplierId,
        status: "DRAFT",
        expectedDate: draft.expectedDate,
        notes: draft.notes,
        total: draft.total,
        createdBy: user.id,
      });
      await tx.insert(purchaseOrderItems).values(lineRows(id, draft.rows));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "PO_CREATED",
        entityType: "purchase_order",
        entityId: id,
        newValues: {
          poNumber,
          supplierId: draft.supplierId,
          lines: draft.rows.length,
          total: draft.total,
        },
        ...meta,
      });

      return { id, poNumber };
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * Locks the order, checks it is in the actor's branch and in one of the `from` states, and returns
 * the row. Anything else is a 404 (other branch, unknown id) or a 409.
 */
export async function lockOrder(tx, user, id, from, verb) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [order] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .for("update");

  if (!order || order.branchId !== user.branchId) {
    throw notFound();
  }

  if (!from.includes(order.status)) {
    throw wrongState(
      `A ${order.status.toLowerCase().replaceAll("_", " ")} order cannot be ${verb}`,
    );
  }

  return order;
}

/** Replaces the header and lines of a DRAFT. */
export async function updatePurchaseOrder(user, id, input, { meta = {} } = {}) {
  return await db.transaction(
    async (tx) => {
      const order = await lockOrder(tx, user, id, ["DRAFT"], "edited");
      const draft = await checkDraft(tx, input);

      await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, id));
      await tx.insert(purchaseOrderItems).values(lineRows(id, draft.rows));
      await tx
        .update(purchaseOrders)
        .set({
          supplierId: draft.supplierId,
          expectedDate: draft.expectedDate,
          notes: draft.notes,
          total: draft.total,
        })
        .where(eq(purchaseOrders.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "PO_UPDATED",
        entityType: "purchase_order",
        entityId: id,
        oldValues: { supplierId: order.supplierId, total: order.total },
        newValues: { supplierId: draft.supplierId, lines: draft.rows.length, total: draft.total },
        ...meta,
      });

      return { id };
    },
    { isolationLevel: "read committed" },
  );
}

/** One status move: lock, check, set, audit. `extra(tx, order, now)` may refuse or add fields. */
async function move(user, id, input, rule, { now = new Date(), meta = {} } = {}) {
  const reason = cleanReason(input, rule.reason === "required");

  if (rule.needs && !can(user, rule.needs)) {
    throw forbidden("You do not have permission for this step");
  }

  return await db.transaction(
    async (tx) => {
      const order = await lockOrder(tx, user, id, rule.from, rule.verb);
      const set = { status: rule.to, ...rule.set?.(user, now) };

      if (rule.check) {
        await rule.check(tx, order);
      }

      await tx.update(purchaseOrders).set(set).where(eq(purchaseOrders.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "purchase_order",
        entityId: id,
        oldValues: { status: order.status },
        newValues: { status: rule.to },
        reason,
        ...meta,
      });

      return { id, status: rule.to };
    },
    { isolationLevel: "read committed" },
  );
}

const RULES = {
  submit: {
    from: ["DRAFT"],
    to: "PENDING_APPROVAL",
    verb: "submitted",
    action: "PO_SUBMITTED",
    needs: PERMISSIONS.PURCHASING_MANAGE,
  },
  return: {
    from: ["PENDING_APPROVAL"],
    to: "DRAFT",
    verb: "returned",
    action: "PO_RETURNED",
    needs: PERMISSIONS.PURCHASING_APPROVE,
  },
  approve: {
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    verb: "approved",
    action: "PO_APPROVED",
    needs: PERMISSIONS.PURCHASING_APPROVE,
    set: (user, now) => {
      return { approvedBy: user.id, approvedAt: now };
    },
  },
  send: {
    from: ["APPROVED"],
    to: "SENT",
    verb: "sent",
    action: "PO_SENT",
    needs: PERMISSIONS.PURCHASING_MANAGE,
    set: (user, now) => {
      return { sentAt: now };
    },
    check: async (tx, order) => {
      const [supplier] = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, order.supplierId));

      if (!supplier?.isActive) {
        throw new HttpError(409, "supplier_inactive", "This supplier is no longer active");
      }
    },
  },
  cancel: {
    from: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
    to: "CANCELLED",
    verb: "cancelled",
    action: "PO_CANCELLED",
    needs: PERMISSIONS.PURCHASING_MANAGE,
    reason: "required",
  },
  close: {
    from: ["PARTIALLY_RECEIVED", "FULLY_RECEIVED"],
    to: "CLOSED",
    verb: "closed",
    action: "PO_CLOSED",
    needs: PERMISSIONS.PURCHASING_MANAGE,
  },
};

export const submitPurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.submit, options);
};
export const returnPurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.return, options);
};
export const approvePurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.approve, options);
};
export const sendPurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.send, options);
};
export const cancelPurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.cancel, options);
};
export const closePurchaseOrder = (user, id, input, options) => {
  return move(user, id, input, RULES.close, options);
};

// ---- reading ----

const sees = (user, branchId) => {
  return branchId === user.branchId || can(user, PERMISSIONS.SALES_VIEW_ALL);
};

const headerSelect = {
  id: purchaseOrders.id,
  poNumber: purchaseOrders.poNumber,
  branchId: purchaseOrders.branchId,
  branchName: branches.name,
  supplierId: purchaseOrders.supplierId,
  supplierName: suppliers.name,
  status: purchaseOrders.status,
  expectedDate: purchaseOrders.expectedDate,
  notes: purchaseOrders.notes,
  total: purchaseOrders.total,
  createdBy: purchaseOrders.createdBy,
  approvedBy: purchaseOrders.approvedBy,
  approvedAt: purchaseOrders.approvedAt,
  sentAt: purchaseOrders.sentAt,
  createdAt: purchaseOrders.createdAt,
};

/** One order with its lines. Other branches are a 404 unless the user has the all-branch scope. */
export async function getPurchaseOrder(user, id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [order] = await db
    .select(headerSelect)
    .from(purchaseOrders)
    .innerJoin(branches, eq(branches.id, purchaseOrders.branchId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.id, id));

  if (!order || !sees(user, order.branchId)) {
    throw notFound();
  }

  const lines = await db
    .select({
      id: purchaseOrderItems.id,
      productId: purchaseOrderItems.productId,
      productUnitId: purchaseOrderItems.productUnitId,
      sku: products.sku,
      productName: products.productName,
      unitName: units.name,
      conversionFactor: purchaseOrderItems.conversionFactor,
      quantityOrdered: purchaseOrderItems.quantityOrdered,
      quantityReceived: purchaseOrderItems.quantityReceived,
      unitCost: purchaseOrderItems.unitCost,
      lineTotal: purchaseOrderItems.lineTotal,
    })
    .from(purchaseOrderItems)
    .innerJoin(products, eq(products.id, purchaseOrderItems.productId))
    .innerJoin(productUnits, eq(productUnits.id, purchaseOrderItems.productUnitId))
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(eq(purchaseOrderItems.purchaseOrderId, id))
    .orderBy(
      asc(products.productName),
      desc(purchaseOrderItems.conversionFactor),
      asc(purchaseOrderItems.id),
    );

  return { order, lines };
}

/** Orders newest first, in the user's branch (all branches with the all-branch scope). */
export async function listPurchaseOrders(user, { status, supplierId, page = 1 } = {}) {
  const conditions = [];

  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    conditions.push(eq(purchaseOrders.branchId, user.branchId ?? ""));
  }

  if (STATUSES.includes(status)) {
    conditions.push(eq(purchaseOrders.status, status));
  }

  if (isUuid(supplierId)) {
    conditions.push(eq(purchaseOrders.supplierId, supplierId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageNumber = Number.isInteger(page) && page > 0 ? page : 1;
  const [{ n }] = await db.select({ n: count() }).from(purchaseOrders).where(where);
  const rows = await db
    .select(headerSelect)
    .from(purchaseOrders)
    .innerJoin(branches, eq(branches.id, purchaseOrders.branchId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(where)
    .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.poNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return { rows, total: n, page: pageNumber, pageSize: PAGE_SIZE };
}

const UNIT_CHOICES = 500;

/** Active product units that may be purchased, for the order form: { id, label } by product name. */
export async function listPurchasableUnits() {
  const rows = await db
    .select({
      id: productUnits.id,
      sku: products.sku,
      productName: products.productName,
      unitName: units.name,
      factor: productUnits.conversionFactor,
    })
    .from(productUnits)
    .innerJoin(products, eq(products.id, productUnits.productId))
    .innerJoin(units, eq(units.id, productUnits.unitId))
    .where(
      and(
        eq(productUnits.canBePurchased, true),
        eq(productUnits.isActive, true),
        eq(products.isActive, true),
      ),
    )
    .orderBy(asc(products.productName), asc(units.name))
    .limit(UNIT_CHOICES);

  return rows.map((row) => {
    return {
      id: row.id,
      label: `${row.productName} (${row.sku}) - ${row.unitName}, ${Number(row.factor)} base units`,
    };
  });
}
