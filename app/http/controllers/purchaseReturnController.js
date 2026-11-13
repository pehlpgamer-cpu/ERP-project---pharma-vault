import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import {
  approvePurchaseReturn,
  cancelPurchaseReturn,
  createPurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
  listReturnableBatches,
  listReturnSuppliers,
  postPurchaseReturn,
  PURCHASE_RETURN_STATUSES,
  rejectPurchaseReturn,
  submitPurchaseReturn,
} from "../../services/purchasing/purchaseReturns.js";
import { HttpError, ValidationError } from "../errors.js";
import { errorMap, reasonRequest } from "../requests/purchasing/purchasingRequest.js";
import {
  purchaseReturnListRequest,
  purchaseReturnRequest,
} from "../requests/purchasing/purchaseReturnRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const RETURNS = "/purchase-returns";
const BLANK_LINES = 3;
const BATCH_LIMIT = 500;

const statusLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

const lineRow = (index, row = {}, errors = {}) => {
  return {
    index,
    inventoryBatchId: row.inventoryBatchId ?? "",
    quantity: row.quantity ?? "",
    errors: {
      inventoryBatchId: errors[`lines.${index}.inventoryBatchId`],
      quantity: errors[`lines.${index}.quantity`],
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

async function returnForm(req, res, { values, lines, errors = {} }) {
  const batchOptions = await listReturnableBatches(req.user);
  const suppliers = await listReturnSuppliers();

  return res.render("purchase-returns/new", {
    pageTitle: "Return stock to a supplier",
    layout: "authenticated",
    values,
    errors,
    suppliers: suppliers.map((supplier) => {
      return { ...supplier, selected: supplier.id === values.supplierId };
    }),
    lineRows: lineRows(lines, errors),
    batchOptions,
    batchesCapped: batchOptions.length >= BATCH_LIMIT,
  });
}

function flagsFor(user, purchaseReturn) {
  const own = purchaseReturn.branchId === user.branchId;
  const manage = own && can(user, PERMISSIONS.PURCHASING_MANAGE);
  const approve = own && can(user, PERMISSIONS.PURCHASING_APPROVE);
  const { status } = purchaseReturn;

  return {
    canSubmit: manage && status === "DRAFT",
    canApprove: approve && status === "PENDING_APPROVAL" && purchaseReturn.createdBy !== user.id,
    needsOtherApprover:
      approve && status === "PENDING_APPROVAL" && purchaseReturn.createdBy === user.id,
    canReject: approve && status === "PENDING_APPROVAL",
    canPost: approve && status === "APPROVED",
    canCancel: (manage || approve) && ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(status),
  };
}

const TRANSITIONS = {
  submit: { run: submitPurchaseReturn, done: "Return submitted for approval" },
  approve: { run: approvePurchaseReturn, done: "Return approved" },
  reject: { run: rejectPurchaseReturn, done: "Return rejected" },
  post: { run: postPurchaseReturn, done: "Return posted: the stock has left the shelf" },
  cancel: { run: cancelPurchaseReturn, done: "Return cancelled" },
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
      } else if (error instanceof HttpError && [403, 409].includes(error.status)) {
        req.flash("error_msg", error.message);
      } else {
        throw error;
      }
    }

    return res.redirect(`${RETURNS}/${req.params.id}`);
  };
}

export default {
  index: async (req, res) => {
    const filters = purchaseReturnListRequest(req.query);
    const status = PURCHASE_RETURN_STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listPurchaseReturns(req.user, {
      status,
      page: filters.page,
    });

    return res.render("purchase-returns/index", {
      pageTitle: "Supplier returns",
      layout: "authenticated",
      returns: rows,
      total,
      canDraft: can(req.user, PERMISSIONS.PURCHASING_MANAGE),
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...PURCHASE_RETURN_STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({ page, perPage: pageSize, total, path: RETURNS, query: { status } }),
    });
  },

  newForm: async (req, res) => {
    return await returnForm(req, res, { values: { supplierId: "", reason: "" }, lines: [] });
  },

  create: async (req, res) => {
    const input = purchaseReturnRequest(req.body);

    try {
      const { id } = await createPurchaseReturn(req.user, input, { meta: requestMeta(req) });

      req.flash("success_msg", "Return saved as a draft");

      return res.redirect(`${RETURNS}/${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await returnForm(req, res, {
        values: { supplierId: input.supplierId ?? "", reason: input.reason ?? "" },
        lines: input.lines,
        errors: errorMap(error.details),
      });
    }
  },

  show: async (req, res) => {
    const { purchaseReturn, lines } = await getPurchaseReturn(req.user, req.params.id);

    return res.render("purchase-returns/show", {
      pageTitle: purchaseReturn.returnNumber,
      layout: "authenticated",
      purchaseReturn,
      lines,
      ...flagsFor(req.user, purchaseReturn),
    });
  },

  submit: transition("submit"),
  approve: transition("approve"),
  reject: transition("reject"),
  post: transition("post"),
  cancel: transition("cancel"),
};
