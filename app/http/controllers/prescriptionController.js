import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import {
  getPrescription,
  listPrescriptions,
  PRESCRIPTION_STATUSES,
  recordPrescription,
  rejectPrescription,
  verifyPrescription,
} from "../../services/sales/prescriptions.js";
import { businessDate } from "../../services/support/time.js";
import { HttpError, ValidationError } from "../errors.js";
import { errorMap, reasonRequest } from "../requests/purchasing/purchasingRequest.js";
import { prescriptionListRequest, recordRequest } from "../requests/sale/prescriptionRequest.js";
import { paginate } from "../support/pagination.js";
import { requestMeta } from "../support/requestMeta.js";

const PRESCRIPTIONS = "/prescriptions";
const BLANK_ROWS = 3;

const statusLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

const itemRow = (index, row = {}, errors = {}) => {
  return {
    index,
    sku: row.sku ?? "",
    prescribedQuantity: row.prescribedQuantity ?? "",
    dosageInstructions: row.dosageInstructions ?? "",
    frequency: row.frequency ?? "",
    duration: row.duration ?? "",
    errors: {
      sku: errors[`items.${index}.sku`],
      prescribedQuantity: errors[`items.${index}.prescribedQuantity`],
      dosageInstructions: errors[`items.${index}.dosageInstructions`],
      frequency: errors[`items.${index}.frequency`],
    },
  };
};

const itemRows = (items, errors) => {
  const rows = items.map((row, index) => {
    return itemRow(index, row, errors);
  });

  for (let index = rows.length; index < Math.max(items.length + BLANK_ROWS, 3); index++) {
    rows.push(itemRow(index, {}, errors));
  }

  return rows;
};

const emptyValues = () => {
  return {
    physicianName: "",
    licenseNumber: "",
    specialization: "",
    contactNumber: "",
    customerNumber: "",
    prescriptionDate: businessDate(new Date()),
    validUntil: "",
  };
};

function recordForm(res, { values, items = [], errors = {} }) {
  return res.render("prescriptions/new", {
    pageTitle: "Record a prescription",
    layout: "authenticated",
    values,
    errors,
    itemRows: itemRows(items, errors),
  });
}

const reviewAction = (name) => {
  const { run, done } = {
    verify: { run: verifyPrescription, done: "Prescription verified" },
    reject: { run: rejectPrescription, done: "Prescription rejected" },
  }[name];

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

    return res.redirect(`${PRESCRIPTIONS}/${req.params.id}`);
  };
};

export default {
  index: async (req, res) => {
    const filters = prescriptionListRequest(req.query);
    const status = PRESCRIPTION_STATUSES.includes(filters.status) ? filters.status : undefined;
    const { rows, total, page, pageSize } = await listPrescriptions(req.user, {
      status,
      q: filters.q,
      page: filters.page,
    });

    return res.render("prescriptions/index", {
      pageTitle: "Prescriptions",
      layout: "authenticated",
      prescriptions: rows,
      total,
      q: filters.q,
      canRecord: can(req.user, PERMISSIONS.PRESCRIPTIONS_MANAGE),
      statusOptions: [
        { value: "", label: "Any status", selected: status === undefined },
        ...PRESCRIPTION_STATUSES.map((value) => {
          return { value, label: statusLabel(value), selected: value === status };
        }),
      ],
      pagination: paginate({
        page,
        perPage: pageSize,
        total,
        path: PRESCRIPTIONS,
        query: { status, q: filters.q === "" ? undefined : filters.q },
      }),
    });
  },

  newForm: (req, res) => {
    return recordForm(res, { values: emptyValues() });
  },

  create: async (req, res) => {
    const input = recordRequest(req.body);

    try {
      const { id } = await recordPrescription(req.user, input, { meta: requestMeta(req) });

      req.flash(
        "success_msg",
        "Prescription recorded; a pharmacist must verify it before it is dispensed",
      );

      return res.redirect(`${PRESCRIPTIONS}/${id}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      res.status(422);

      return recordForm(res, {
        values: {
          physicianName: input.physician.fullName ?? "",
          licenseNumber: input.physician.licenseNumber ?? "",
          specialization: input.physician.specialization ?? "",
          contactNumber: input.physician.contactNumber ?? "",
          customerNumber: input.customerNumber ?? "",
          prescriptionDate: input.prescriptionDate ?? "",
          validUntil: input.validUntil ?? "",
        },
        items: input.items,
        errors: errorMap(
          error.details.map((detail) => {
            // the form names the physician fields without the "physician." prefix
            return {
              ...detail,
              path: detail.path
                .replace(/^physician\.fullName$/, "physicianName")
                .replace(/^physician\./, ""),
            };
          }),
        ),
      });
    }
  },

  show: async (req, res) => {
    const { prescription, items, sales } = await getPrescription(req.user, req.params.id);
    const pending = prescription.status === "PENDING_VERIFICATION";

    return res.render("prescriptions/show", {
      pageTitle: prescription.prescriptionNumber,
      layout: "authenticated",
      prescription,
      items,
      sales,
      canReview: pending && can(req.user, PERMISSIONS.PRESCRIPTIONS_VERIFY),
    });
  },

  verify: reviewAction("verify"),
  reject: reviewAction("reject"),
};
