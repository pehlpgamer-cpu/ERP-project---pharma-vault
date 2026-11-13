// Prescriptions: recorded by anyone who may (cashiers included), verified or rejected by a pharmacist,
// then dispensed through checkout, which calls loadDispensable and applyDispensing inside the sale's
// own transaction so the quantities used, the dispensing record and the sale commit or roll back
// together. Prescriptions are chain-wide records: they have no branch.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { customers } from "../../models/customers.js";
import { dispensingItems } from "../../models/dispensing-items.js";
import { dispensings } from "../../models/dispensings.js";
import { prescribingPhysicians } from "../../models/prescribing-physicians.js";
import { prescriptionItems } from "../../models/prescription-items.js";
import { prescriptions } from "../../models/prescriptions.js";
import { products } from "../../models/products.js";
import { salePrescriptions } from "../../models/sale-prescriptions.js";
import { sales } from "../../models/sales.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { nextDocumentNumber } from "../purchasing/numbers.js";
import { add, cmp, sub, toScale } from "../support/decimal.js";
import { isUuid } from "../support/ids.js";
import { businessDate, isRealDay, toDateString } from "../support/time.js";

const MAX_ITEMS = 50;
const MAX_TEXT = 2000;
const PAGE_SIZE = 25;
const QUANTITY = /^\d{1,11}(\.\d{1,3})?$/;
const DISPENSABLE = ["VERIFIED", "PARTIALLY_DISPENSED"];
const OPEN = ["PENDING_VERIFICATION", ...DISPENSABLE];

export const PRESCRIPTION_STATUSES = [
  "PENDING_VERIFICATION",
  "VERIFIED",
  "PARTIALLY_DISPENSED",
  "FULLY_DISPENSED",
  "REJECTED",
  "EXPIRED",
];

const forbidden = (message) => {
  return new HttpError(403, "forbidden", message);
};

const notFound = () => {
  return new HttpError(404, "not_found", "Prescription not found");
};

const text = (value) => {
  return typeof value === "string" ? value.trim() : "";
};

const atMidnight = (day) => {
  return new Date(`${day}T00:00:00Z`);
};

const isPastDue = (row, today) => {
  const until = toDateString(row.validUntil);

  return until !== null && until < today;
};

// EXPIRED is computed, not stored: an open prescription past its valid-until date is expired.
const effectiveStatus = (row, today) => {
  return OPEN.includes(row.status) && isPastDue(row, today) ? "EXPIRED" : row.status;
};

// ---- recording ----

async function checkRecord(tx, input, today) {
  const errors = [];
  const add_ = (path, message) => {
    errors.push({ path, message });
  };
  const doctor = input?.physician ?? {};
  const fullName = text(doctor.fullName);
  const license = text(doctor.licenseNumber);
  const specialization = text(doctor.specialization);
  const contact = text(doctor.contactNumber);

  if (fullName === "" || fullName.length > 255) {
    add_("physician.fullName", "Enter the prescriber's full name");
  }

  if (license === "" || license.length > 100) {
    add_("physician.licenseNumber", "Enter the prescriber's license number");
  }

  if (specialization.length > 150 || contact.length > 50) {
    add_("physician.specialization", "Specialization or contact number is too long");
  }

  const date = text(input?.prescriptionDate);
  const until = text(input?.validUntil);

  if (!isRealDay(date) || date > today) {
    add_("prescriptionDate", "Enter the date on the prescription (not in the future)");
  }

  if (until !== "" && (!isRealDay(until) || (isRealDay(date) && until < date))) {
    add_("validUntil", "Valid until must be a real date on or after the prescription date");
  }

  let physicianRow = null;

  if (fullName !== "" && license !== "" && license.length <= 100) {
    [physicianRow] = await tx
      .select()
      .from(prescribingPhysicians)
      .where(eq(prescribingPhysicians.licenseNumber, license))
      .limit(1);

    if (physicianRow && physicianRow.fullName.trim().toLowerCase() !== fullName.toLowerCase()) {
      add_(
        "physician.licenseNumber",
        `This license number belongs to ${physicianRow.fullName}. Check the name and number.`,
      );
    }
  }

  const customerNumber = text(input?.customerNumber);
  let customer = null;

  if (customerNumber !== "") {
    [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.customerNumber, customerNumber))
      .limit(1);

    if (!customer) {
      add_("customerNumber", "No customer has that number");
    }
  }

  const rawItems = Array.isArray(input?.items) ? input.items : [];
  const filled = rawItems
    .map((item, index) => {
      return { item, index };
    })
    .filter(({ item }) => {
      return text(item?.sku) !== "" || text(item?.prescribedQuantity) !== "";
    });

  if (filled.length === 0 || filled.length > MAX_ITEMS || rawItems.length > MAX_ITEMS * 2) {
    add_("items", `Add 1 to ${MAX_ITEMS} prescribed products`);
  }

  const skus = filled.slice(0, MAX_ITEMS).map(({ item }) => {
    return text(item.sku);
  });
  const found =
    skus.length === 0
      ? []
      : await tx
          .select({ id: products.id, sku: products.sku, isActive: products.isActive })
          .from(products)
          .where(inArray(products.sku, skus));
  const bySku = new Map(
    found.map((row) => {
      return [row.sku.toLowerCase(), row];
    }),
  );
  const seen = new Set();
  const items = [];

  if (filled.length <= MAX_ITEMS && rawItems.length <= MAX_ITEMS * 2) {
    for (const { item, index } of filled) {
      const product = bySku.get(text(item.sku).toLowerCase());
      const quantity = text(item.prescribedQuantity);
      const dosage = text(item.dosageInstructions);
      const frequency = text(item.frequency);
      const duration = text(item.duration);
      let ok = true;

      if (!product || !product.isActive) {
        add_(`items.${index}.sku`, "No active product has that SKU");
        ok = false;
      } else if (seen.has(product.id)) {
        add_(`items.${index}.sku`, "This product is already on the prescription");
        ok = false;
      } else {
        seen.add(product.id);
      }

      if (!QUANTITY.test(quantity) || cmp(quantity, "0") <= 0) {
        add_(
          `items.${index}.prescribedQuantity`,
          "Enter the prescribed quantity in base units, above 0",
        );
        ok = false;
      }

      if (dosage === "" || dosage.length > MAX_TEXT) {
        add_(`items.${index}.dosageInstructions`, "Enter the dosage instructions");
        ok = false;
      }

      if (frequency.length > 150 || duration.length > 150) {
        add_(`items.${index}.frequency`, "Frequency or duration is too long");
        ok = false;
      }

      if (ok) {
        items.push({
          productId: product.id,
          quantity: toScale(quantity, 3),
          dosage,
          frequency: frequency === "" ? null : frequency,
          duration: duration === "" ? null : duration,
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return {
    physician: physicianRow,
    doctor: {
      fullName,
      license,
      specialization: specialization === "" ? null : specialization,
      contact: contact === "" ? null : contact,
    },
    customer,
    date,
    until: until === "" ? null : until,
    items,
  };
}

/**
 * A new PENDING_VERIFICATION prescription. `input`: `{ physician: { fullName, licenseNumber,
 * specialization?, contactNumber? }, customerNumber?, prescriptionDate, validUntil?, items: [{ sku,
 * prescribedQuantity (base units), dosageInstructions, frequency?, duration? }] }`.
 * Returns { id, prescriptionNumber }.
 */
export async function recordPrescription(user, input, { now = new Date(), meta = {} } = {}) {
  if (!can(user, PERMISSIONS.PRESCRIPTIONS_MANAGE)) {
    throw forbidden("You do not have permission to record prescriptions");
  }

  if (!user.branchId) {
    throw forbidden("Prescriptions are recorded at a branch, and this account has none");
  }

  return await db.transaction(
    async (tx) => {
      const today = businessDate(now);
      const draft = await checkRecord(tx, input, today);
      const id = randomUUID();
      const physicianId = draft.physician?.id ?? randomUUID();

      if (!draft.physician) {
        await tx.insert(prescribingPhysicians).values({
          id: physicianId,
          fullName: draft.doctor.fullName,
          licenseNumber: draft.doctor.license,
          specialization: draft.doctor.specialization,
          contactNumber: draft.doctor.contact,
        });
      }

      const prescriptionNumber = await nextDocumentNumber(tx, "RX", user.branchCode, today);

      await tx.insert(prescriptions).values({
        id,
        customerId: draft.customer?.id ?? null,
        physicianId,
        prescriptionNumber,
        prescriptionDate: atMidnight(draft.date),
        validUntil: draft.until === null ? null : atMidnight(draft.until),
        status: "PENDING_VERIFICATION",
      });
      await tx.insert(prescriptionItems).values(
        draft.items.map((item) => {
          return {
            id: randomUUID(),
            prescriptionId: id,
            productId: item.productId,
            prescribedQuantity: item.quantity,
            dosageInstructions: item.dosage,
            frequency: item.frequency,
            duration: item.duration,
          };
        }),
      );
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "PRESCRIPTION_RECORDED",
        entityType: "prescription",
        entityId: id,
        newValues: {
          prescriptionNumber,
          physician: draft.doctor.fullName,
          items: draft.items.length,
        },
        ...meta,
      });

      return { id, prescriptionNumber };
    },
    { isolationLevel: "read committed" },
  );
}

// ---- verification ----

async function review(user, id, input, rule, { now = new Date(), meta = {} } = {}) {
  const reason = text(input?.reason);

  if (rule.reason && (reason === "" || reason.length > 500)) {
    throw new ValidationError([
      { path: "reason", message: "Give a reason of 1 to 500 characters" },
    ]);
  }

  if (!can(user, PERMISSIONS.PRESCRIPTIONS_VERIFY)) {
    throw forbidden("Only a pharmacist can verify or reject prescriptions");
  }

  if (!isUuid(id)) {
    throw notFound();
  }

  return await db.transaction(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, id))
        .for("update");

      if (!row) {
        throw notFound();
      }

      if (row.status !== "PENDING_VERIFICATION") {
        throw new HttpError(
          409,
          "prescription_state",
          `A ${row.status.toLowerCase().replaceAll("_", " ")} prescription cannot be ${rule.verb}`,
        );
      }

      if (rule.liveOnly && isPastDue(row, businessDate(now))) {
        throw new HttpError(409, "prescription_expired", "This prescription has expired");
      }

      await tx
        .update(prescriptions)
        .set({
          status: rule.to,
          ...(rule.to === "VERIFIED" ? { verifiedBy: user.id, verifiedAt: now } : {}),
        })
        .where(eq(prescriptions.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: rule.action,
        entityType: "prescription",
        entityId: id,
        oldValues: { status: row.status },
        newValues: { status: rule.to },
        reason: reason === "" ? null : reason,
        ...meta,
      });

      return { id, status: rule.to };
    },
    { isolationLevel: "read committed" },
  );
}

export const verifyPrescription = (user, id, input, options) => {
  return review(
    user,
    id,
    input,
    { to: "VERIFIED", verb: "verified", action: "PRESCRIPTION_VERIFIED", liveOnly: true },
    options,
  );
};

export const rejectPrescription = (user, id, input, options) => {
  return review(
    user,
    id,
    input,
    { to: "REJECTED", verb: "rejected", action: "PRESCRIPTION_REJECTED", reason: true },
    options,
  );
};

// ---- dispensing (called by checkout inside its transaction) ----

/**
 * Locks a prescription and its items for a sale. Throws ValidationError (unknown id), 409
 * prescription_invalid (not verified, or already fully dispensed, rejected) or prescription_expired.
 * Returns { prescription, items } with each item's `remaining` base quantity.
 */
export async function loadDispensable(tx, prescriptionId, today) {
  const [prescription] = isUuid(prescriptionId)
    ? await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, prescriptionId))
        .for("update")
    : [];

  if (!prescription) {
    throw new ValidationError([{ path: "prescriptionId", message: "Unknown prescription" }]);
  }

  if (!DISPENSABLE.includes(prescription.status) || prescription.verifiedBy === null) {
    throw new HttpError(
      409,
      "prescription_invalid",
      `A ${prescription.status.toLowerCase().replaceAll("_", " ")} prescription cannot be dispensed`,
    );
  }

  if (isPastDue(prescription, today)) {
    throw new HttpError(409, "prescription_expired", "This prescription has expired");
  }

  const items = await tx
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, prescriptionId))
    .orderBy(asc(prescriptionItems.id))
    .for("update");

  return {
    prescription,
    items: items.map((item) => {
      return {
        ...item,
        remaining: toScale(sub(item.prescribedQuantity, item.totalDispensedQuantity), 3),
      };
    }),
  };
}

/** `wanted`: Map productId → base quantity the sale takes. Throws 409 prescription_quantity. */
export function checkQuantities(items, wanted) {
  const byProduct = new Map(
    items.map((item) => {
      return [item.productId, item];
    }),
  );
  const over = [];

  for (const [productId, quantity] of wanted) {
    const item = byProduct.get(productId);

    if (!item || cmp(quantity, item.remaining) > 0) {
      over.push({
        productId,
        requested: toScale(quantity, 3),
        remaining: item ? item.remaining : "0.000",
      });
    }
  }

  if (over.length > 0) {
    throw new HttpError(
      409,
      "prescription_quantity",
      "The prescription does not cover that quantity",
      over,
    );
  }
}

/** Writes the dispensing, adds to what was dispensed and moves the prescription's status. */
export async function applyDispensing(tx, { prescription, items, saleId, wanted, now }) {
  const dispensingId = randomUUID();

  await tx.insert(dispensings).values({
    id: dispensingId,
    prescriptionId: prescription.id,
    saleId,
    // the cashier completes the sale; the pharmacist on record is the one who verified it
    pharmacistId: prescription.verifiedBy,
    dispensedAt: now,
    status: "COMPLETED",
  });

  const rows = [];
  let complete = true;

  for (const item of items) {
    const quantity = wanted.get(item.productId);
    const total = quantity
      ? add(item.totalDispensedQuantity, quantity)
      : item.totalDispensedQuantity;

    if (quantity) {
      rows.push({
        id: randomUUID(),
        dispensingId,
        prescriptionItemId: item.id,
        productId: item.productId,
        quantityDispensed: toScale(quantity, 3),
      });
      await tx
        .update(prescriptionItems)
        .set({ totalDispensedQuantity: toScale(total, 3) })
        .where(eq(prescriptionItems.id, item.id));
    }

    if (cmp(total, item.prescribedQuantity) < 0) {
      complete = false;
    }
  }

  await tx.insert(dispensingItems).values(rows);
  await tx.insert(salePrescriptions).values({ saleId, prescriptionId: prescription.id });

  const status = complete ? "FULLY_DISPENSED" : "PARTIALLY_DISPENSED";

  await tx.update(prescriptions).set({ status }).where(eq(prescriptions.id, prescription.id));

  return status;
}

// ---- reading ----

const headerSelect = {
  id: prescriptions.id,
  prescriptionNumber: prescriptions.prescriptionNumber,
  storedStatus: prescriptions.status,
  physicianName: prescribingPhysicians.fullName,
  licenseNumber: prescribingPhysicians.licenseNumber,
  specialization: prescribingPhysicians.specialization,
  contactNumber: prescribingPhysicians.contactNumber,
  customerFirstName: customers.firstName,
  customerLastName: customers.lastName,
  customerNumber: customers.customerNumber,
  prescriptionDate: prescriptions.prescriptionDate,
  validUntil: prescriptions.validUntil,
  verifiedByName: users.name,
  verifiedAt: prescriptions.verifiedAt,
  createdAt: prescriptions.createdAt,
};

function headerQuery(executor) {
  return executor
    .select(headerSelect)
    .from(prescriptions)
    .innerJoin(prescribingPhysicians, eq(prescribingPhysicians.id, prescriptions.physicianId))
    .leftJoin(customers, eq(customers.id, prescriptions.customerId))
    .leftJoin(users, eq(users.id, prescriptions.verifiedBy));
}

function shape(row, now) {
  const { storedStatus, customerFirstName, customerLastName, ...rest } = row;

  return {
    ...rest,
    status: effectiveStatus(
      { status: storedStatus, validUntil: row.validUntil },
      businessDate(now),
    ),
    prescriptionDate: toDateString(row.prescriptionDate),
    validUntil: toDateString(row.validUntil),
    customerName: customerFirstName ? `${customerFirstName} ${customerLastName}` : null,
  };
}

/** One prescription with its items (and what is left of each) and the sales that dispensed it. */
export async function getPrescription(user, id, { now = new Date() } = {}) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await headerQuery(db).where(eq(prescriptions.id, id));

  if (!row) {
    throw notFound();
  }

  const items = await db
    .select({
      id: prescriptionItems.id,
      productId: prescriptionItems.productId,
      sku: products.sku,
      productName: products.productName,
      prescribed: prescriptionItems.prescribedQuantity,
      dispensed: prescriptionItems.totalDispensedQuantity,
      dosageInstructions: prescriptionItems.dosageInstructions,
      frequency: prescriptionItems.frequency,
      duration: prescriptionItems.duration,
    })
    .from(prescriptionItems)
    .innerJoin(products, eq(products.id, prescriptionItems.productId))
    .where(eq(prescriptionItems.prescriptionId, id))
    .orderBy(asc(products.productName), asc(prescriptionItems.id));
  const linked = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      totalAmount: sales.totalAmount,
      transactionDate: sales.transactionDate,
    })
    .from(salePrescriptions)
    .innerJoin(sales, eq(sales.id, salePrescriptions.saleId))
    .where(eq(salePrescriptions.prescriptionId, id))
    .orderBy(desc(sales.transactionDate));

  return {
    prescription: shape(row, now),
    items: items.map((item) => {
      return {
        id: item.id,
        productId: item.productId,
        sku: item.sku,
        productName: item.productName,
        prescribedQuantity: toScale(item.prescribed, 3),
        dispensedQuantity: toScale(item.dispensed, 3),
        remainingQuantity: toScale(sub(item.prescribed, item.dispensed), 3),
        dosageInstructions: item.dosageInstructions,
        frequency: item.frequency,
        duration: item.duration,
      };
    }),
    sales: linked,
  };
}

const escapeLike = (value) => {
  return value.replace(/[\\%_]/g, (character) => {
    return `\\${character}`;
  });
};

/** Prescriptions newest first, optionally filtered by status and by a part of the number. */
export async function listPrescriptions(user, { status, q, page = 1, now = new Date() } = {}) {
  const today = businessDate(now);
  const conditions = [];

  if (status === "EXPIRED") {
    conditions.push(inArray(prescriptions.status, OPEN));
    conditions.push(sql`${prescriptions.validUntil} < ${today}`);
  } else if (PRESCRIPTION_STATUSES.includes(status)) {
    conditions.push(eq(prescriptions.status, status));
  }

  if (typeof q === "string" && q.trim() !== "") {
    conditions.push(like(prescriptions.prescriptionNumber, `%${escapeLike(q.trim())}%`));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const pageNumber = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
  const [{ n }] = await db.select({ n: count() }).from(prescriptions).where(where);
  const rows = await headerQuery(db)
    .where(where)
    .orderBy(desc(prescriptions.createdAt), desc(prescriptions.prescriptionNumber))
    .limit(PAGE_SIZE)
    .offset((pageNumber - 1) * PAGE_SIZE);

  return {
    rows: rows.map((row) => {
      return shape(row, now);
    }),
    total: n,
    page: pageNumber,
    pageSize: PAGE_SIZE,
  };
}

/**
 * For the sales screen: a prescription by its number, if it can be dispensed now, with what is left
 * of each product. 404 for an unknown number, 409 when it cannot be dispensed.
 */
export async function lookupDispensable(user, number, { now = new Date() } = {}) {
  const wanted = text(number);
  const [row] =
    wanted === ""
      ? []
      : await headerQuery(db).where(eq(prescriptions.prescriptionNumber, wanted)).limit(1);

  if (!row) {
    throw notFound();
  }

  const view = shape(row, now);

  if (view.status === "EXPIRED") {
    throw new HttpError(409, "prescription_expired", "This prescription has expired");
  }

  if (!DISPENSABLE.includes(view.status)) {
    throw new HttpError(
      409,
      "prescription_invalid",
      `A ${view.status.toLowerCase().replaceAll("_", " ")} prescription cannot be dispensed`,
    );
  }

  const { items } = await getPrescription(user, row.id, { now });

  return {
    id: row.id,
    prescriptionNumber: view.prescriptionNumber,
    customerName: view.customerName ?? "No customer on file",
    items: items
      .filter((item) => {
        return cmp(item.remainingQuantity, "0") > 0;
      })
      .map((item) => {
        return {
          productId: item.productId,
          productName: item.productName,
          remaining: item.remainingQuantity,
        };
      }),
  };
}
