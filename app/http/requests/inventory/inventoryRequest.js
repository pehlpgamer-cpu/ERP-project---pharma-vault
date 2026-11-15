import * as z from "zod";
import { wholeNumber, withoutEmptyValues } from "../fields.js";
import { parse } from "../../../services/support/validate.js";

const Q = z.string().max(100, "Search text must be at most 100 characters").optional();
const Branch = z.uuid({ error: "Unknown branch" }).optional();

const OverviewQuery = z.object({
  q: Q,
  flag: z
    .enum(["any", "low", "expiring", "expired"], {
      error: "Show must be any, low, expiring or expired",
    })
    .optional(),
  branchId: Branch,
});

const BatchQuery = z.object({
  q: Q,
  status: z
    .enum(["ACTIVE", "QUARANTINED", "RECALLED", "EXPIRED", "DEPLETED"], {
      error: "Unknown batch status",
    })
    .optional(),
  expiry: z
    .enum(["any", "expired", "30", "60", "90"], {
      error: "Expiry must be any, expired, 30, 60 or 90",
    })
    .optional(),
  branchId: Branch,
  page: wholeNumber.optional(),
});

/** Validates GET /inventory query parameters and applies the defaults (every product). */
export function overviewRequest(query) {
  const data = parse(OverviewQuery, withoutEmptyValues(query));

  return { q: data.q, flag: data.flag ?? "any", branchId: data.branchId };
}

/** Validates GET /inventory/batches query parameters and applies the defaults (any status, page 1). */
export function batchListRequest(query) {
  const data = parse(BatchQuery, withoutEmptyValues(query));

  return {
    q: data.q,
    status: data.status,
    expiry: data.expiry ?? "any",
    branchId: data.branchId,
    page: data.page ?? 1,
  };
}

/** The fields an action form posts; the service validates the reason and the write-off kind. */
export function actionRequest(body) {
  const reason = body?.reason;
  const kind = body?.kind;

  return {
    reason: typeof reason === "string" ? reason : undefined,
    kind: typeof kind === "string" ? kind : undefined,
  };
}
