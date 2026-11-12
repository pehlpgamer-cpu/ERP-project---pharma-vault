import * as z from "zod";
import { parse } from "../validate.js";

const STATUSES = ["PENDING", "COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"];
const PAYMENT_METHODS = ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"];
const SORTS = [
  "transactionDate",
  "-transactionDate",
  "totalAmount",
  "-totalAmount",
  "invoiceNumber",
  "-invoiceNumber",
];

const wholeNumber = z
  .string()
  .regex(/^\d+$/, "Must be a whole number")
  .transform(Number)
  .pipe(z.number().int().min(1));

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);

    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Not a real calendar date");

// "COMPLETED,VOIDED" -> ["COMPLETED", "VOIDED"], each checked against the enum.
const statusList = z
  .string()
  .transform((value) => {
    return value
      .split(",")
      .map((part) => {
        return part.trim();
      })
      .filter(Boolean);
  })
  .pipe(z.array(z.enum(STATUSES)).min(1));

const Scope = z.object({
  branchId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

function checkRange(data, context) {
  if (data.from && data.to && data.from > data.to) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
  }
}

const ListQuery = Scope.extend({
  page: wholeNumber.optional(),
  perPage: wholeNumber.pipe(z.number().max(100)).optional(),
  sort: z.enum(SORTS).optional(),
  status: statusList.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  q: z.string().min(1).max(100).optional(),
}).superRefine(checkRange);

const SummaryQuery = Scope.superRefine(checkRange);

// `?q=&status=` means "not given", exactly like leaving the parameter out.
function withoutEmptyValues(query) {
  return Object.fromEntries(
    Object.entries(query ?? {}).filter(([, value]) => {
      return value !== "";
    }),
  );
}

/**
 * Validates GET /sales query parameters and applies the defaults (page 1, 20 per page, newest
 * first). Throws ValidationError.
 */
export function listSalesRequest(query) {
  const data = parse(ListQuery, withoutEmptyValues(query));

  return {
    ...data,
    page: data.page ?? 1,
    perPage: data.perPage ?? 20,
    sort: data.sort ?? "-transactionDate",
  };
}

/** Validates GET /sales/summary query parameters (from, to, branchId, cashierId). */
export function summaryRequest(query) {
  return parse(SummaryQuery, withoutEmptyValues(query));
}
