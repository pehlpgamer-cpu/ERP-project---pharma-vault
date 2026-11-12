import {
  quarantineBatch,
  recallBatch,
  releaseBatch,
  writeOffBatch,
} from "../../services/inventory/batchActions.js";
import {
  getStockOverview,
  listBatches,
  listBranches,
  resolveBranch,
} from "../../services/inventory/stockOverview.js";
import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import { HttpError, ValidationError } from "../errors.js";
import {
  actionRequest,
  batchListRequest,
  overviewRequest,
} from "../requests/inventory/inventoryRequest.js";
import { paginate } from "../support/pagination.js";
import { isSafeReturnTo } from "../support/returnTo.js";
import { requestMeta } from "../support/requestMeta.js";

const PER_PAGE = 20;
const BATCHES = "/inventory/batches";

const FLAGS = [
  { value: "any", label: "All products" },
  { value: "low", label: "Low stock" },
  { value: "expiring", label: "Expiring within 30 days" },
  { value: "expired", label: "Holding expired stock" },
];
const STATUSES = ["ACTIVE", "QUARANTINED", "RECALLED", "EXPIRED", "DEPLETED"];
const EXPIRIES = [
  { value: "any", label: "Any expiry" },
  { value: "expired", label: "Already expired" },
  { value: "30", label: "Within 30 days" },
  { value: "60", label: "Within 60 days" },
  { value: "90", label: "Within 90 days" },
];

const selecting = (options, current) => {
  return options.map((option) => {
    return { ...option, selected: option.value === current };
  });
};

// Invalid filters are shown as a notice and the defaults are used, never a 500.
function parseFilters(parser, query) {
  try {
    return { filters: parser(query), filterErrors: [] };
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }

    return {
      filters: parser({}),
      filterErrors: error.details.map((detail) => {
        return `${detail.path}: ${detail.message}`;
      }),
    };
  }
}

async function branchChoices(user, branchId) {
  if (!can(user, PERMISSIONS.SALES_VIEW_ALL)) {
    return [];
  }

  return (await listBranches()).map((branch) => {
    return {
      value: branch.id,
      label: `${branch.name} (${branch.code})`,
      selected: branch.id === branchId,
    };
  });
}

// A post goes back to the batch list it came from (same filters), or to the plain list.
function backTo(body) {
  const back = body?.back;

  return isSafeReturnTo(back) && (back === BATCHES || back.startsWith(`${BATCHES}?`))
    ? back
    : BATCHES;
}

function rowActions(batch) {
  const live = batch.status === "ACTIVE" || batch.status === "QUARANTINED";

  return {
    canQuarantine: batch.status === "ACTIVE",
    canRelease: batch.status === "QUARANTINED",
    canRecall: live,
    canWriteOff: live && Number(batch.quantityAvailable) > 0,
  };
}

const ACTIONS = {
  quarantine: { run: quarantineBatch, done: "Batch quarantined" },
  release: { run: releaseBatch, done: "Batch released" },
  recall: { run: recallBatch, done: "Batch recalled" },
  writeOff: { run: writeOffBatch, done: "Batch written off" },
};

function perform(name) {
  const { run, done } = ACTIONS[name];

  return async (req, res) => {
    try {
      await run(req.user, req.params.id, actionRequest(req.body), { meta: requestMeta(req) });
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

    return res.redirect(backTo(req.body));
  };
}

export default {
  index: async (req, res) => {
    const { filters, filterErrors } = parseFilters(overviewRequest, req.query);
    const branchId = resolveBranch(req.user, filters.branchId);
    const { rows } = await getStockOverview({ user: req.user, ...filters, branchId });

    return res.render("inventory/index", {
      pageTitle: "Inventory",
      layout: "authenticated",
      rows,
      filters: { q: filters.q ?? "", flag: filters.flag },
      filterErrors,
      flagOptions: selecting(FLAGS, filters.flag),
      branchId,
      branchOptions: await branchChoices(req.user, branchId),
    });
  },

  batches: async (req, res) => {
    const { filters, filterErrors } = parseFilters(batchListRequest, req.query);
    const branchId = resolveBranch(req.user, filters.branchId);
    const { rows, total } = await listBatches({
      user: req.user,
      ...filters,
      branchId,
      perPage: PER_PAGE,
    });
    const query = filterErrors.length > 0 ? {} : { ...req.query, branchId: filters.branchId };

    return res.render("inventory/batches", {
      pageTitle: "Stock batches",
      layout: "authenticated",
      batches: rows.map((row) => {
        return { ...row, ...rowActions(row) };
      }),
      total,
      filters: { q: filters.q ?? "" },
      filterErrors,
      canManage: can(req.user, PERMISSIONS.INVENTORY_MANAGE),
      branchId,
      branchOptions: await branchChoices(req.user, branchId),
      statusOptions: selecting(
        [
          { value: "", label: "Any status" },
          ...STATUSES.map((value) => {
            return { value, label: value.charAt(0) + value.slice(1).toLowerCase() };
          }),
        ],
        filters.status ?? "",
      ),
      expiryOptions: selecting(EXPIRIES, filters.expiry),
      back: paginate({ page: filters.page, perPage: PER_PAGE, total, path: BATCHES, query }).links
        .self,
      pagination: paginate({
        page: filters.page,
        perPage: PER_PAGE,
        total,
        path: BATCHES,
        query,
      }),
    });
  },

  quarantine: perform("quarantine"),
  release: perform("release"),
  recall: perform("recall"),
  writeOff: perform("writeOff"),
};
