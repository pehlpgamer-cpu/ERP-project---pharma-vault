import {
  createSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "../../services/purchasing/suppliers.js";
import { ValidationError } from "../errors.js";
import {
  errorMap,
  supplierListRequest,
  supplierRequest,
} from "../requests/purchasing/purchasingRequest.js";
import { requestMeta } from "../support/requestMeta.js";

const blank = () => {
  return {
    id: "",
    code: "",
    name: "",
    contactName: "",
    phone: "",
    email: "",
    taxId: "",
    paymentTerms: "",
    address: "",
    isActive: true,
  };
};

const ACTIVE_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "yes", label: "Active" },
  { value: "no", label: "Inactive" },
];

const form = (res, { values, errors = {}, isNew, action }) => {
  return res.render("suppliers/form", {
    pageTitle: isNew ? "New supplier" : "Edit supplier",
    layout: "authenticated",
    values,
    errors,
    isNew,
    action,
  });
};

// a refused form shows what was typed, so only text and the flag come back
const echo = (body, input) => {
  return {
    ...blank(),
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => {
        return typeof value === "string";
      }),
    ),
    isActive: input.isActive,
    ...(body?.id ? { id: body.id } : {}),
  };
};

export default {
  index: async (req, res) => {
    const filters = supplierListRequest(req.query);
    const active = req.query?.active;

    return res.render("suppliers/index", {
      pageTitle: "Suppliers",
      layout: "authenticated",
      suppliers: await listSuppliers(filters),
      filters: { q: filters.q ?? "" },
      activeOptions: ACTIVE_OPTIONS.map((option) => {
        return { ...option, selected: option.value === (active ?? "") };
      }),
    });
  },

  newForm: (req, res) => {
    return form(res, { values: blank(), isNew: true, action: "/suppliers" });
  },

  create: async (req, res) => {
    const input = supplierRequest(req.body);

    try {
      await createSupplier(req.user, input, { meta: requestMeta(req) });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return form(res, {
        values: echo(req.body, { ...input, isActive: true }),
        errors: errorMap(error.details),
        isNew: true,
        action: "/suppliers",
      });
    }

    req.flash("success_msg", "Supplier added");

    return res.redirect("/suppliers");
  },

  editForm: async (req, res) => {
    const supplier = await getSupplier(req.params.id);

    return form(res, {
      values: { ...blank(), ...supplier },
      isNew: false,
      action: `/suppliers/${supplier.id}`,
    });
  },

  update: async (req, res) => {
    const input = supplierRequest(req.body);
    const action = `/suppliers/${req.params.id}`;

    try {
      await updateSupplier(req.user, req.params.id, input, { meta: requestMeta(req) });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return form(res, {
        values: { ...echo(req.body, input), id: req.params.id },
        errors: errorMap(error.details),
        isNew: false,
        action,
      });
    }

    req.flash("success_msg", "Supplier saved");

    return res.redirect("/suppliers");
  },
};
