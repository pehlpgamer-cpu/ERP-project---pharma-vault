import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import { sub } from "../../services/support/decimal.js";
import {
  approveTransfer,
  cancelTransfer,
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransferableBatches,
  listTransferSources,
  listTransfers,
  receiveTransfer,
  rejectTransfer,
  submitTransfer,
  TRANSFER_STATUSES,
} from "../../services/inventory/transfers.js";
import { HttpError, ValidationError } from "../errors.js";
import {
  quantitiesRequest,
  transferListRequest,
  transferRequest,
} from "../requests/inventory/transferRequest.js";
import { errorMap, reasonRequest } from "../requests/purchasing/purchasingRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const TRANSFERS = "/transfers";
const BLANK_LINES = 3;
const BATCH_LIMIT = 500;

const statusLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

const lineRow = (index, row = {}, errors = {}) => {
  return {
    index,
    sourceBatchId: row.sourceBatchId ?? "",
    quantity: row.quantity ?? "",
    errors: {
      sourceBatchId: errors[`lines.${index}.sourceBatchId`],
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

async function requestForm(req, res, { sourceBranchId, lines = [], errors = {} }) {
  const sources = await listTransferSources(req.user);
  const source = sources.find((branch) => {
    return branch.id === sourceBranchId;
  });
  const batchOptions = source ? await listTransferableBatches(req.user, source.id) : [];

  return res.render("transfers/new", {
    pageTitle: "Request a transfer",
    layout: "authenticated",
    sources: sources.map((branch) => {
      return { ...branch, selected: branch.id === source?.id };
    }),
    source: source ?? null,
    errors,
    lineRows: lineRows(lines, errors),
    batchOptions,
    batchesCapped: batchOptions.length >= BATCH_LIMIT,
  });
}

function flagsFor(user, transfer) {
  const mine = user.branchId;
  const asSource = mine === transfer.sourceBranchId;
  const asDestination = mine === transfer.destinationBranchId;
  const manage = can(user, PERMISSIONS.TRANSFERS_MANAGE);
  const approve = can(user, PERMISSIONS.TRANSFERS_APPROVE);
  const { status } = transfer;
  const open = ["IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(status);

  return {
    canSubmit: asDestination && manage && status === "DRAFT",
    canApprove: asSource && approve && status === "PENDING_APPROVAL",
    canReject: asSource && approve && status === "PENDING_APPROVAL",
    canDispatch: asSource && manage && status === "APPROVED",
    canReceive: asDestination && manage && open,
    canClose: asDestination && manage && open,
    canCancel:
      ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(status) &&
      ((asDestination && manage) || (asSource && approve)),
  };
}

const TRANSITIONS = {
  submit: { run: submitTransfer, done: "Transfer submitted for approval", read: reasonRequest },
  approve: { run: approveTransfer, done: "Transfer approved", read: reasonRequest },
  reject: { run: rejectTransfer, done: "Transfer rejected", read: reasonRequest },
  cancel: { run: cancelTransfer, done: "Transfer cancelled", read: reasonRequest },
  close: { run: closeTransfer, done: "Transfer closed with what arrived", read: reasonRequest },
  dispatch: {
    run: dispatchTransfer,
    done: "Transfer dispatched: the stock is now in transit",
    read: quantitiesRequest,
  },
  receive: {
    run: receiveTransfer,
    done: "Receipt recorded",
    read: quantitiesRequest,
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

    return res.redirect(`${TRANSFERS}/${req.params.id}`);
  };
}

export default {
  index: async (req, res) => {
    const filters = transferListRequest(req.query);
    const status = TRANSFER_STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listTransfers(req.user, {
      status,
      page: filters.page,
    });

    return res.render("transfers/index", {
      pageTitle: "Transfers",
      layout: "authenticated",
      transfers: rows,
      total,
      canRequest: can(req.user, PERMISSIONS.TRANSFERS_MANAGE),
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...TRANSFER_STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({ page, perPage: pageSize, total, path: TRANSFERS, query: { status } }),
    });
  },

  newForm: async (req, res) => {
    const source = typeof req.query.source === "string" ? req.query.source : undefined;

    return await requestForm(req, res, { sourceBranchId: source });
  },

  create: async (req, res) => {
    const input = transferRequest(req.body);

    try {
      const { id } = await createTransfer(req.user, input, { meta: requestMeta(req) });

      req.flash("success_msg", "Request saved as a draft");

      return res.redirect(`${TRANSFERS}/${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await requestForm(req, res, {
        sourceBranchId: input.sourceBranchId,
        lines: input.lines,
        errors: errorMap(error.details),
      });
    }
  },

  show: async (req, res) => {
    const { transfer, lines } = await getTransfer(req.user, req.params.id);

    return res.render("transfers/show", {
      pageTitle: transfer.transferNumber,
      layout: "authenticated",
      transfer,
      lines: lines.map((line, index) => {
        return {
          ...line,
          index,
          toShip: line.quantityRequested,
          toReceive: sub(line.quantityShipped, line.quantityReceived),
        };
      }),
      ...flagsFor(req.user, transfer),
    });
  },

  submit: transition("submit"),
  approve: transition("approve"),
  reject: transition("reject"),
  cancel: transition("cancel"),
  close: transition("close"),
  dispatch: transition("dispatch"),
  receive: transition("receive"),
};
