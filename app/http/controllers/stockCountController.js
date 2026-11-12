import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import {
  ADJUSTMENT_STATUSES,
  approveAdjustment,
  cancelAdjustment,
  createAdjustment,
  getAdjustment,
  listAdjustments,
  listCountableBatches,
  postAdjustment,
  rejectAdjustment,
  submitAdjustment,
} from "../../services/inventory/adjustments.js";
import { HttpError, ValidationError } from "../errors.js";
import { countListRequest, countRequest } from "../requests/inventory/countRequest.js";
import { errorMap, reasonRequest } from "../requests/purchasing/purchasingRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const COUNTS = "/stock-counts";
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
    countedQuantity: row.countedQuantity ?? "",
    errors: {
      inventoryBatchId: errors[`lines.${index}.inventoryBatchId`],
      countedQuantity: errors[`lines.${index}.countedQuantity`],
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

async function countForm(req, res, { values, lines, errors = {} }) {
  const batchOptions = await listCountableBatches(req.user);

  return res.render("inventory/count-form", {
    pageTitle: "New stock count",
    layout: "authenticated",
    values,
    errors,
    lineRows: lineRows(lines, errors),
    batchOptions,
    batchesCapped: batchOptions.length >= BATCH_LIMIT,
  });
}

function flagsFor(user, adjustment) {
  const own = adjustment.branchId === user.branchId;
  const adjust = own && can(user, PERMISSIONS.INVENTORY_ADJUST);
  const approve = own && can(user, PERMISSIONS.INVENTORY_APPROVE);

  return {
    canSubmit: adjust && adjustment.status === "DRAFT",
    canApprove:
      approve && adjustment.status === "PENDING_APPROVAL" && adjustment.createdBy !== user.id,
    needsOtherApprover:
      approve && adjustment.status === "PENDING_APPROVAL" && adjustment.createdBy === user.id,
    canReject: approve && adjustment.status === "PENDING_APPROVAL",
    canPost: approve && adjustment.status === "APPROVED",
    canCancel: adjust && ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(adjustment.status),
  };
}

const TRANSITIONS = {
  submit: { run: submitAdjustment, done: "Count submitted for approval" },
  approve: { run: approveAdjustment, done: "Count approved" },
  reject: { run: rejectAdjustment, done: "Count rejected" },
  post: { run: postAdjustment, done: "Count posted: stock now matches what was counted" },
  cancel: { run: cancelAdjustment, done: "Count cancelled" },
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

    return res.redirect(`${COUNTS}/${req.params.id}`);
  };
}

export default {
  index: async (req, res) => {
    const filters = countListRequest(req.query);
    const status = ADJUSTMENT_STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listAdjustments(req.user, {
      status,
      page: filters.page,
    });

    return res.render("inventory/counts", {
      pageTitle: "Stock counts",
      layout: "authenticated",
      counts: rows,
      total,
      canAdjust: can(req.user, PERMISSIONS.INVENTORY_ADJUST),
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...ADJUSTMENT_STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({ page, perPage: pageSize, total, path: COUNTS, query: { status } }),
    });
  },

  newForm: async (req, res) => {
    return await countForm(req, res, { values: { reason: "" }, lines: [] });
  },

  create: async (req, res) => {
    const input = countRequest(req.body);

    try {
      const { id } = await createAdjustment(req.user, input, { meta: requestMeta(req) });

      req.flash("success_msg", "Count saved as a draft");

      return res.redirect(`${COUNTS}/${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return await countForm(req, res, {
        values: { reason: input.reason ?? "" },
        lines: input.lines,
        errors: errorMap(error.details),
      });
    }
  },

  show: async (req, res) => {
    const { adjustment, lines } = await getAdjustment(req.user, req.params.id);

    return res.render("inventory/count", {
      pageTitle: adjustment.adjustmentNumber,
      layout: "authenticated",
      adjustment,
      lines,
      ...flagsFor(req.user, adjustment),
    });
  },

  submit: transition("submit"),
  approve: transition("approve"),
  reject: transition("reject"),
  post: transition("post"),
  cancel: transition("cancel"),
};
