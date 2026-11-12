import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchasableUnits,
  listPurchaseOrders,
  returnPurchaseOrder,
  sendPurchaseOrder,
  submitPurchaseOrder,
  updatePurchaseOrder,
} from "../../services/purchasing/purchaseOrders.js";
import { listReceipts, postReceipt } from "../../services/purchasing/receiving.js";
import { listSuppliers } from "../../services/purchasing/suppliers.js";
import { sub, cmp, toScale } from "../../services/support/decimal.js";
import { HttpError, ValidationError } from "../errors.js";
import {
  errorMap,
  orderListRequest,
  orderRequest,
  reasonRequest,
  receiptRequest,
} from "../requests/purchasing/purchasingRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

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
const BLANK_LINES = 3;
const SLOTS_PER_LINE = 2;
const ORDERS = "/purchase-orders";

const statusLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

// ---- the order form ----

const lineRow = (index, row = {}, errors = {}) => {
  return {
    index,
    productUnitId: row.productUnitId ?? "",
    quantity: row.quantity ?? "",
    unitCost: row.unitCost ?? "",
    errors: {
      productUnitId: errors[`lines.${index}.productUnitId`],
      quantity: errors[`lines.${index}.quantity`],
      unitCost: errors[`lines.${index}.unitCost`],
    },
  };
};

// the lines given plus a few blank rows to type into
const lineRows = (lines, errors) => {
  const rows = lines.map((row, index) => {
    return lineRow(index, row, errors);
  });

  for (let index = rows.length; index < Math.max(lines.length + BLANK_LINES, 5); index++) {
    rows.push(lineRow(index, {}, errors));
  }

  return rows;
};

async function orderForm(res, { values, lines, errors = {}, isNew, action, orderNumber = null }) {
  const supplierOptions = (await listSuppliers({ active: true })).map((supplier) => {
    return {
      value: supplier.id,
      label: `${supplier.name} (${supplier.code})`,
      selected: supplier.id === values.supplierId,
    };
  });

  return res.render("purchasing/order-form", {
    pageTitle: isNew ? "New purchase order" : "Edit purchase order",
    layout: "authenticated",
    values,
    errors,
    isNew,
    action,
    orderNumber,
    lineRows: lineRows(lines, errors),
    supplierOptions,
    unitOptions: await listPurchasableUnits(),
  });
}

// ---- the order page ----

function flagsFor(user, order) {
  const own = order.branchId === user.branchId;
  const manage = own && can(user, PERMISSIONS.PURCHASING_MANAGE);
  const approve = own && can(user, PERMISSIONS.PURCHASING_APPROVE);

  return {
    canEdit: manage && order.status === "DRAFT",
    canSubmit: manage && order.status === "DRAFT",
    canReturn: approve && order.status === "PENDING_APPROVAL",
    canApprove: approve && order.status === "PENDING_APPROVAL",
    canSend: manage && order.status === "APPROVED",
    canCancel: manage && ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(order.status),
    canClose: manage && ["PARTIALLY_RECEIVED", "FULLY_RECEIVED"].includes(order.status),
    canReceive:
      own &&
      can(user, PERMISSIONS.INVENTORY_RECEIVE) &&
      ["SENT", "PARTIALLY_RECEIVED"].includes(order.status),
  };
}

const TRANSITIONS = {
  submit: { run: submitPurchaseOrder, done: "Order submitted for approval" },
  return: { run: returnPurchaseOrder, done: "Order returned to draft" },
  approve: { run: approvePurchaseOrder, done: "Order approved" },
  send: { run: sendPurchaseOrder, done: "Order marked as sent to the supplier" },
  cancel: { run: cancelPurchaseOrder, done: "Order cancelled" },
  close: { run: closePurchaseOrder, done: "Order closed" },
};

function transition(name) {
  const { run, done } = TRANSITIONS[name];

  return async (req, res) => {
    try {
      await run(req.user, req.params.id, reasonRequest(req.body), { meta: requestMeta(req) });
      req.flash("success_msg", done);
    } catch (error) {
      if (error instanceof ValidationError) {
        req.flash("error_msg", error.details[0]?.message ?? "Check the form and try again");
      } else if (error instanceof HttpError && error.status === 409) {
        req.flash("error_msg", error.message);
      } else {
        throw error;
      }
    }

    return res.redirect(`${ORDERS}/${req.params.id}`);
  };
}

// ---- the receiving form ----

// Two rows per order line, so one line can arrive as two manufacturer batches.
function receiveRows(lines, posted, errors) {
  const rows = [];

  lines.forEach((line, lineIndex) => {
    for (let slot = 0; slot < SLOTS_PER_LINE; slot++) {
      const index = lineIndex * SLOTS_PER_LINE + slot;
      const row = posted[index] ?? {};
      const open = toScale(sub(line.quantityOrdered, line.quantityReceived), 3);

      rows.push({
        index,
        first: slot === 0,
        purchaseOrderItemId: line.id,
        productName: line.productName,
        sku: line.sku,
        unitName: line.unitName,
        open,
        batchNumber: row.batchNumber ?? "",
        expirationDate: row.expirationDate ?? "",
        manufacturingDate: row.manufacturingDate ?? "",
        quantityAccepted: row.quantityAccepted ?? "",
        quantityRejected: row.quantityRejected ?? "",
        rejectionReason: row.rejectionReason ?? "",
        errors: {
          batchNumber: errors[`lines.${index}.batchNumber`],
          expirationDate: errors[`lines.${index}.expirationDate`],
          manufacturingDate: errors[`lines.${index}.manufacturingDate`],
          quantityAccepted: errors[`lines.${index}.quantityAccepted`],
          quantityRejected: errors[`lines.${index}.quantityRejected`],
          rejectionReason: errors[`lines.${index}.rejectionReason`],
          purchaseOrderItemId: errors[`lines.${index}.purchaseOrderItemId`],
        },
      });
    }
  });

  return rows;
}

// only lines with something left to receive are offered
const stillOpen = (lines) => {
  return lines.filter((line) => {
    return cmp(line.quantityOrdered, line.quantityReceived) > 0;
  });
};

async function receiveForm(req, res, { posted = [], values = {}, errors = {} } = {}) {
  const { order, lines } = await getPurchaseOrder(req.user, req.params.id);
  const flags = flagsFor(req.user, order);

  if (!flags.canReceive) {
    req.flash("error_msg", `A ${statusLabel(order.status).toLowerCase()} order cannot be received`);

    return res.redirect(`${ORDERS}/${order.id}`);
  }

  return res.render("purchasing/receive", {
    pageTitle: `Receive ${order.poNumber}`,
    layout: "authenticated",
    order,
    rows: receiveRows(stillOpen(lines), posted, errors),
    values: {
      supplierInvoiceNumber: values.supplierInvoiceNumber ?? "",
      notes: values.notes ?? "",
    },
    errors,
    action: `${ORDERS}/${order.id}/receive`,
  });
}

export default {
  index: async (req, res) => {
    const filters = orderListRequest(req.query);
    const status = STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listPurchaseOrders(req.user, {
      status,
      page: filters.page,
    });

    return res.render("purchasing/orders", {
      pageTitle: "Purchase orders",
      layout: "authenticated",
      orders: rows,
      total,
      canManage: can(req.user, PERMISSIONS.PURCHASING_MANAGE),
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({
        page,
        perPage: pageSize,
        total,
        path: ORDERS,
        query: { status },
      }),
    });
  },

  newForm: async (req, res) => {
    return await orderForm(res, {
      values: { supplierId: "", expectedDate: "", notes: "" },
      lines: [],
      isNew: true,
      action: ORDERS,
    });
  },

  create: async (req, res) => {
    const input = orderRequest(req.body);

    try {
      const { id } = await createPurchaseOrder(req.user, input, { meta: requestMeta(req) });

      req.flash("success_msg", "Draft saved");

      return res.redirect(`${ORDERS}/${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await orderForm(res, {
        values: {
          supplierId: input.supplierId ?? "",
          expectedDate: input.expectedDate ?? "",
          notes: input.notes ?? "",
        },
        lines: input.lines,
        errors: errorMap(error.details),
        isNew: true,
        action: ORDERS,
      });
    }
  },

  show: async (req, res) => {
    const { order, lines } = await getPurchaseOrder(req.user, req.params.id);

    return res.render("purchasing/order", {
      pageTitle: order.poNumber,
      layout: "authenticated",
      order,
      lines,
      receipts: await listReceipts(order.id),
      ...flagsFor(req.user, order),
    });
  },

  editForm: async (req, res) => {
    const { order, lines } = await getPurchaseOrder(req.user, req.params.id);

    if (!flagsFor(req.user, order).canEdit) {
      req.flash("error_msg", "Only a draft in your branch can be edited");

      return res.redirect(`${ORDERS}/${order.id}`);
    }

    return await orderForm(res, {
      values: {
        supplierId: order.supplierId,
        expectedDate: order.expectedDate ? String(order.expectedDate).slice(0, 10) : "",
        notes: order.notes ?? "",
      },
      lines: lines.map((line) => {
        return {
          productUnitId: line.productUnitId,
          quantity: line.quantityOrdered,
          unitCost: line.unitCost,
        };
      }),
      isNew: false,
      action: `${ORDERS}/${order.id}`,
      orderNumber: order.poNumber,
    });
  },

  update: async (req, res) => {
    const input = orderRequest(req.body);

    try {
      await updatePurchaseOrder(req.user, req.params.id, input, { meta: requestMeta(req) });
      req.flash("success_msg", "Draft saved");

      return res.redirect(`${ORDERS}/${req.params.id}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        req.flash("error_msg", error.message);

        return res.redirect(`${ORDERS}/${req.params.id}`);
      }

      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await orderForm(res, {
        values: {
          supplierId: input.supplierId ?? "",
          expectedDate: input.expectedDate ?? "",
          notes: input.notes ?? "",
        },
        lines: input.lines,
        errors: errorMap(error.details),
        isNew: false,
        action: `${ORDERS}/${req.params.id}`,
      });
    }
  },

  submit: transition("submit"),
  return: transition("return"),
  approve: transition("approve"),
  send: transition("send"),
  cancel: transition("cancel"),
  close: transition("close"),

  receiveForm: async (req, res) => {
    return await receiveForm(req, res);
  },

  receive: async (req, res) => {
    const input = receiptRequest(req.body);

    try {
      const result = await postReceipt(req.user, req.params.id, input, {
        meta: requestMeta(req),
      });

      req.flash("success_msg", `Receipt ${result.receiptNumber} posted`);

      return res.redirect(`${ORDERS}/${req.params.id}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        req.flash("error_msg", error.message);

        return res.redirect(`${ORDERS}/${req.params.id}`);
      }

      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await receiveForm(req, res, {
        posted: input.lines,
        values: input,
        errors: errorMap(error.details),
      });
    }
  },
};
