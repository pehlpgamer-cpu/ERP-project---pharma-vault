// Suppliers: the people purchase orders are written to. A supplier is never deleted, only
// deactivated, so old orders keep their link. Every change is audited in the same transaction.

import { randomUUID } from "node:crypto";
import { and, asc, eq, like, or } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError, ValidationError } from "../../http/errors.js";
import { suppliers } from "../../models/suppliers.js";
import { recordAudit } from "../audit/auditLog.js";
import { isDuplicateEntry } from "../support/dbErrors.js";
import { isUuid } from "../support/ids.js";

const LIST_LIMIT = 200;
const LIKE_SPECIALS = /[\\%_]/g;

const FIELDS = [
  { key: "code", label: "Code", max: 50, required: true },
  { key: "name", label: "Name", max: 255, required: true },
  { key: "contactName", label: "Contact", max: 255 },
  { key: "phone", label: "Phone", max: 50 },
  { key: "email", label: "Email", max: 255 },
  { key: "taxId", label: "Tax ID", max: 100 },
  { key: "paymentTerms", label: "Payment terms", max: 255 },
  { key: "address", label: "Address", max: 2000 },
];

const notFound = () => {
  return new HttpError(404, "not_found", "Supplier not found");
};

/** Trims the form fields and refuses what the table cannot hold. Throws ValidationError. */
export function cleanSupplier(input) {
  const errors = [];
  const values = {};

  for (const { key, label, max, required } of FIELDS) {
    const raw = input?.[key];
    const text = typeof raw === "string" ? raw.trim() : "";

    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      errors.push({ path: key, message: `${label} must be text` });
    } else if (text === "" && required) {
      errors.push({ path: key, message: `${label} is required` });
    } else if (text.length > max) {
      errors.push({ path: key, message: `${label} is at most ${max} characters` });
    } else {
      values[key] = text === "" ? null : text;
    }
  }

  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.push({ path: "email", message: "Enter a valid email address" });
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }

  return values;
}

const duplicateCode = () => {
  return new ValidationError([{ path: "code", message: "That supplier code is already used" }]);
};

const view = (row) => {
  return { ...row };
};

/** Suppliers by name. `q` matches code or name; `active` true/false filters, undefined shows all. */
export async function listSuppliers({ q, active } = {}) {
  const conditions = [];
  const text = typeof q === "string" ? q.trim() : "";

  if (text !== "") {
    const pattern = `%${text.replace(LIKE_SPECIALS, "\\$&")}%`;

    conditions.push(or(like(suppliers.name, pattern), like(suppliers.code, pattern)));
  }

  if (typeof active === "boolean") {
    conditions.push(eq(suppliers.isActive, active));
  }

  const rows = await db
    .select()
    .from(suppliers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(suppliers.name), asc(suppliers.code))
    .limit(LIST_LIMIT);

  return rows.map(view);
}

export async function getSupplier(id) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id));

  if (!row) {
    throw notFound();
  }

  return view(row);
}

export async function createSupplier(user, input, { meta = {} } = {}) {
  const values = cleanSupplier(input);

  try {
    return await db.transaction(async (tx) => {
      const id = randomUUID();

      await tx.insert(suppliers).values({ id, ...values, isActive: true });
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId ?? null,
        action: "SUPPLIER_CREATED",
        entityType: "supplier",
        entityId: id,
        newValues: values,
        ...meta,
      });

      return { id };
    });
  } catch (error) {
    throw isDuplicateEntry(error) ? duplicateCode() : error;
  }
}

/** Replaces the supplier's details; `isActive` (boolean) turns purchasing from it on or off. */
export async function updateSupplier(user, id, input, { meta = {} } = {}) {
  if (!isUuid(id)) {
    throw notFound();
  }

  const values = cleanSupplier(input);
  const isActive = typeof input?.isActive === "boolean" ? input.isActive : undefined;

  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).for("update");

      if (!before) {
        throw notFound();
      }

      const next = { ...values, isActive: isActive ?? before.isActive };

      await tx.update(suppliers).set(next).where(eq(suppliers.id, id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId ?? null,
        action: before.isActive && !next.isActive ? "SUPPLIER_DEACTIVATED" : "SUPPLIER_UPDATED",
        entityType: "supplier",
        entityId: id,
        oldValues: Object.fromEntries(
          [...FIELDS.map((field) => field.key), "isActive"].map((key) => {
            return [key, before[key]];
          }),
        ),
        newValues: next,
        ...meta,
      });

      return { id };
    });
  } catch (error) {
    throw isDuplicateEntry(error) ? duplicateCode() : error;
  }
}
