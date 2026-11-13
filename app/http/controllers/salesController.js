import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import { loadFilterOptions } from "../../services/sales/filterOptions.js";
import { getSale, listSales } from "../../services/sales/salesQuery.js";
import { salesScope } from "../../services/sales/scope.js";
import { addDays, businessDate } from "../../services/support/time.js";
import { HttpError, ValidationError } from "../errors.js";
import { listSalesRequest } from "../requests/sale/listSalesRequest.js";
import { paginate } from "../support/pagination.js";

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "COMPLETED", label: "Completed" },
  { value: "PARTIALLY_REFUNDED", label: "Partially refunded" },
  { value: "REFUNDED", label: "Refunded" },
  { value: "VOIDED", label: "Voided" },
  { value: "PENDING", label: "Pending" },
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "", label: "Any payment method" },
  { value: "CASH", label: "Cash" },
  { value: "CARD", label: "Card" },
  { value: "GCASH", label: "GCash" },
  { value: "MAYA", label: "Maya" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "OTHER", label: "Other" },
];

const withSelection = (options, selected) => {
  return options.map((option) => {
    return { ...option, selected: option.value === selected };
  });
};

export default {
  index: async (req, res) => {
    let filters;
    let filterErrors = [];

    try {
      filters = listSalesRequest(req.query);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      filterErrors = error.details.map((detail) => {
        return `${detail.path}: ${detail.message}`;
      });
      filters = listSalesRequest({});
    }

    const { rows, total } = await listSales(filters, req.user);
    const options = await loadFilterOptions(req.user);
    const today = businessDate(new Date());
    const echo = {
      q: filters.q ?? "",
      from: filters.from ?? "",
      to: filters.to ?? "",
      status: filters.status?.join(",") ?? "",
      paymentMethod: filters.paymentMethod ?? "",
      branchId: filters.branchId ?? "",
      cashierId: filters.cashierId ?? "",
    };

    return res.render("sales/index", {
      pageTitle: "Sales",
      layout: "authenticated",
      sales: rows,
      total,
      filters: echo,
      filterErrors,
      pagination: paginate({
        page: filters.page,
        perPage: filters.perPage,
        total,
        path: "/sales",
        query: filterErrors.length > 0 ? {} : req.query,
      }),
      scopeLevel: salesScope(req.user).level,
      statusOptions: withSelection(STATUS_OPTIONS, echo.status),
      paymentMethodOptions: withSelection(PAYMENT_METHOD_OPTIONS, echo.paymentMethod),
      branches: options.branches.map((branch) => {
        return { ...branch, selected: branch.id === echo.branchId };
      }),
      cashiers: options.cashiers.map((cashier) => {
        return { ...cashier, selected: cashier.id === echo.cashierId };
      }),
      presets: [
        { label: "Today", url: `/sales?from=${today}&to=${today}` },
        { label: "Last 7 days", url: `/sales?from=${addDays(today, -6)}&to=${today}` },
        { label: "Last 30 days", url: `/sales?from=${addDays(today, -29)}&to=${today}` },
      ],
    });
  },

  show: async (req, res) => {
    const sale = await getSale(req.params.id, req.user);

    if (sale === null) {
      throw new HttpError(404, "not_found", "Sale not found");
    }

    return res.render("sales/show", {
      pageTitle: `Sale ${sale.invoiceNumber}`,
      layout: "authenticated",
      sale,
      canReturn:
        can(req.user, PERMISSIONS.RETURNS_CREATE) &&
        sale.branch.id === req.user.branchId &&
        ["COMPLETED", "PARTIALLY_REFUNDED"].includes(sale.status),
      autoPrint: req.query.print === "1",
    });
  },
};
