import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import { cmp, sub } from "../../services/support/decimal.js";
import {
  approveReturn,
  cancelReturn,
  createReturn,
  DISPOSITIONS,
  getReturn,
  getReturnableSale,
  listReturns,
  processReturn,
  RETURN_STATUSES,
  rejectReturn,
  submitReturn,
} from "../../services/sales/returns.js";
import { HttpError, ValidationError } from "../errors.js";
import { errorMap, reasonRequest } from "../requests/purchasing/purchasingRequest.js";
import {
  processRequest,
  returnListRequest,
  returnRequest,
} from "../requests/sale/returnRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const RETURNS = "/returns";

const DISPOSITION_LABELS = {
  RESTOCK: "Restock (can be sold again)",
  QUARANTINE: "Quarantine",
  DAMAGED: "Damaged",
  DISPOSE: "Dispose",
};

const statusLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

const dispositionOptions = (selected) => {
  return DISPOSITIONS.map((value) => {
    return { value, label: DISPOSITION_LABELS[value], selected: value === selected };
  });
};

// one row per batch piece of the sale, with what was typed (by position) and the errors for it
const formRows = (pieces, lines, errors) => {
  return pieces.map((piece, index) => {
    const line = lines[index] ?? {};

    return {
      index,
      ...piece,
      quantity: line.quantity ?? "",
      dispositions: dispositionOptions(line.disposition ?? "RESTOCK"),
      errors: {
        quantity: errors[`lines.${index}.quantity`],
        disposition: errors[`lines.${index}.disposition`],
      },
    };
  });
};

async function returnForm(req, res, { values, lines, errors = {} }) {
  const { sale, blocked, pieces } = await getReturnableSale(req.user, req.params.id);

  return res.render("returns/new", {
    pageTitle: `Return for ${sale.invoiceNumber}`,
    layout: "authenticated",
    sale,
    blocked,
    values,
    errors,
    rows: formRows(pieces, lines, errors),
  });
}

// One row per method the sale can still be refunded by, with the refund prefilled in that order
// (each method up to what it has left) so the usual case needs no typing.
function refundRows(refundable, refundAmount) {
  let remaining = refundAmount;

  return refundable.map((entry, index) => {
    const amount = cmp(entry.left, remaining) < 0 ? entry.left : remaining;

    remaining = sub(remaining, amount);

    return {
      index,
      method: entry.method,
      left: entry.left,
      amount: cmp(amount, "0") > 0 ? amount : "",
    };
  });
}

function flagsFor(user, salesReturn) {
  const own = salesReturn.branchId === user.branchId;
  const create = own && can(user, PERMISSIONS.RETURNS_CREATE);
  const approve = own && can(user, PERMISSIONS.RETURNS_APPROVE);
  const { status } = salesReturn;

  return {
    canSubmit: create && status === "DRAFT",
    canApprove: approve && status === "PENDING_APPROVAL" && salesReturn.createdBy !== user.id,
    needsOtherApprover:
      approve && status === "PENDING_APPROVAL" && salesReturn.createdBy === user.id,
    canReject: approve && status === "PENDING_APPROVAL",
    canProcess: approve && status === "APPROVED",
    canCancel:
      (create || approve) &&
      (["DRAFT", "PENDING_APPROVAL"].includes(status) || (status === "APPROVED" && approve)),
  };
}

const TRANSITIONS = {
  submit: { run: submitReturn, done: "Return submitted for approval", read: reasonRequest },
  approve: { run: approveReturn, done: "Return approved", read: reasonRequest },
  reject: { run: rejectReturn, done: "Return rejected", read: reasonRequest },
  cancel: { run: cancelReturn, done: "Return cancelled", read: reasonRequest },
  process: {
    run: processReturn,
    done: "Return processed: stock and refund are recorded",
    read: processRequest,
  },
};

function transition(name) {
  const { run, done, read } = TRANSITIONS[name];

  return async (req, res) => {
    try {
      await run(req.user, req.params.id, read(req.body), { meta: requestMeta(req) });
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
    const filters = returnListRequest(req.query);
    const status = RETURN_STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listReturns(req.user, {
      status,
      page: filters.page,
    });

    return res.render("returns/index", {
      pageTitle: "Returns",
      layout: "authenticated",
      returns: rows,
      total,
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...RETURN_STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({ page, perPage: pageSize, total, path: RETURNS, query: { status } }),
    });
  },

  newForm: async (req, res) => {
    return await returnForm(req, res, { values: { reason: "" }, lines: [] });
  },

  create: async (req, res) => {
    const input = returnRequest(req.body);

    try {
      const { id } = await createReturn(
        req.user,
        { ...input, saleId: req.params.id },
        { meta: requestMeta(req) },
      );

      req.flash("success_msg", "Return saved as a draft");

      return res.redirect(`${RETURNS}/${id}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        req.flash("error_msg", error.message);

        return res.redirect(`/sales/${req.params.id}`);
      }

      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await returnForm(req, res, {
        values: { reason: input.reason ?? "" },
        lines: input.lines,
        errors: errorMap(error.details),
      });
    }
  },

  show: async (req, res) => {
    const { salesReturn, lines, refund, refundable } = await getReturn(req.user, req.params.id);

    return res.render("returns/show", {
      pageTitle: salesReturn.returnNumber,
      layout: "authenticated",
      salesReturn,
      lines,
      refund,
      refundRows: refundRows(refundable, salesReturn.refundAmount),
      dispositionLabels: DISPOSITION_LABELS,
      ...flagsFor(req.user, salesReturn),
    });
  },

  submit: transition("submit"),
  approve: transition("approve"),
  reject: transition("reject"),
  cancel: transition("cancel"),
  process: transition("process"),
};
