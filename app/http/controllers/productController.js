import {
  createProduct,
  getProductForEdit,
  listProducts,
  loadFormOptions,
  setProductActive,
  updateProduct,
} from "../../services/catalog/productAdmin.js";
import { HttpError, ValidationError } from "../errors.js";
import { productListRequest } from "../requests/product/productListRequest.js";
import { echoProductForm, productRequest } from "../requests/product/productRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const PER_PAGE = 20;

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "any", label: "Any status" },
];

const CLASSIFICATIONS = [
  { value: "OTC", label: "Over the counter" },
  { value: "PRESCRIPTION", label: "Prescription" },
  { value: "CONTROLLED", label: "Controlled" },
  { value: "OTHER", label: "Other" },
];

const blankUnit = () => {
  return {
    id: "",
    unitId: "",
    conversionFactor: "",
    isBaseUnit: false,
    canBeSold: true,
    isActive: true,
    barcodes: [],
    barcodesText: "",
    price: "",
    errors: {},
  };
};

const blankProduct = () => {
  return {
    id: "",
    sku: "",
    productName: "",
    genericName: "",
    brandName: "",
    strength: "",
    dosageForm: "",
    categoryId: "",
    manufacturerId: "",
    description: "",
    prescriptionClassification: "OTC",
    requiresPrescription: false,
    reorderLevel: "",
    isActive: true,
    units: [{ ...blankUnit(), conversionFactor: "1", isBaseUnit: true }],
  };
};

// Field errors for the form: product-level ones by path, unit-level ones on their row.
function splitErrors(details) {
  const top = {};
  const rows = {};

  for (const { path, message } of details) {
    const match = /^units\.(\d+)\.(\w+)$/.exec(path);

    if (match) {
      rows[match[1]] ??= {};
      rows[match[1]][match[2]] ??= message;
    } else {
      top[path] ??= message;
    }
  }

  return { top, rows };
}

function forForm(product, rowErrors = {}) {
  return {
    ...product,
    units: product.units.map((unit, index) => {
      return {
        ...unit,
        barcodesText: (unit.barcodes ?? []).join(", "),
        errors: rowErrors[index] ?? {},
      };
    }),
  };
}

function renderForm(res, { status = 200, product, errors = {}, hasHistory, isNew, action, title }) {
  return loadFormOptions().then((options) => {
    return res.status(status).render("products/form", {
      pageTitle: title,
      layout: "authenticated",
      values: product,
      errors,
      hasHistory,
      isNew,
      action,
      categories: options.categories,
      manufacturers: options.manufacturers,
      unitOptions: options.units,
      classifications: CLASSIFICATIONS,
      blankRow: blankUnit(),
    });
  });
}

// What a refused form shows: the typed values, with the errors beside their fields.
function refused(error, body) {
  const { top, rows } = splitErrors(error.details);
  const typed = echoProductForm(body) ?? blankProduct();

  return { product: forForm({ ...blankProduct(), ...typed }, rows), errors: top };
}

export default {
  index: async (req, res) => {
    let filters;
    let filterErrors = [];

    try {
      filters = productListRequest(req.query);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      filterErrors = error.details.map((detail) => {
        return `${detail.path}: ${detail.message}`;
      });
      filters = productListRequest({});
    }

    const { rows, total } = await listProducts({ ...filters, perPage: PER_PAGE });
    const options = await loadFormOptions();

    return res.render("products/index", {
      pageTitle: "Products",
      layout: "authenticated",
      products: rows,
      total,
      filters: { q: filters.q ?? "", status: filters.status, categoryId: filters.categoryId ?? "" },
      filterErrors,
      statusOptions: STATUS_OPTIONS.map((option) => {
        return { ...option, selected: option.value === filters.status };
      }),
      categories: options.categories.map((category) => {
        return { ...category, selected: category.id === filters.categoryId };
      }),
      pagination: paginate({
        page: filters.page,
        perPage: PER_PAGE,
        total,
        path: "/products",
        query: filterErrors.length > 0 ? {} : req.query,
      }),
    });
  },

  create: (req, res) => {
    return renderForm(res, {
      product: forForm(blankProduct()),
      hasHistory: false,
      isNew: true,
      action: "/products",
      title: "New product",
    });
  },

  store: async (req, res) => {
    let input;

    try {
      input = productRequest(req.body);
      await createProduct(req.user, input, { meta: requestMeta(req) });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      return renderForm(res, {
        status: 422,
        ...refused(error, req.body),
        hasHistory: false,
        isNew: true,
        action: "/products",
        title: "New product",
      });
    }

    req.flash("success_msg", `Product "${input.productName}" created`);

    return res.redirect("/products");
  },

  edit: async (req, res) => {
    const found = await getProductForEdit(req.params.id);

    if (found === null) {
      throw new HttpError(404, "not_found", "Product not found");
    }

    return renderForm(res, {
      product: forForm(found.product),
      hasHistory: found.hasHistory,
      isNew: false,
      action: `/products/${found.product.id}`,
      title: `Edit ${found.product.productName}`,
    });
  },

  update: async (req, res) => {
    const found = await getProductForEdit(req.params.id);

    if (found === null) {
      throw new HttpError(404, "not_found", "Product not found");
    }

    let input;

    try {
      input = productRequest(req.body);
      await updateProduct(req.user, req.params.id, input, { meta: requestMeta(req) });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      return renderForm(res, {
        status: 422,
        ...refused(error, req.body),
        hasHistory: found.hasHistory,
        isNew: false,
        action: `/products/${found.product.id}`,
        title: `Edit ${found.product.productName}`,
      });
    }

    req.flash("success_msg", `Product "${input.productName}" saved`);

    return res.redirect("/products");
  },

  status: async (req, res) => {
    if (!["0", "1"].includes(req.body?.active)) {
      throw new ValidationError([{ path: "active", message: "Send active=1 or active=0" }]);
    }

    const active = req.body.active === "1";
    const { changed } = await setProductActive(req.user, req.params.id, active, {
      meta: requestMeta(req),
    });

    if (changed) {
      req.flash("success_msg", active ? "Product activated" : "Product deactivated");
    }

    return res.redirect("/products");
  },
};
