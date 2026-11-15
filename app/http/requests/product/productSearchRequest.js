import * as z from "zod";
import { wholeNumber, withoutEmptyValues } from "../fields.js";
import { parse } from "../../../services/support/validate.js";

const DEFAULT_LIMIT = 20;

const SearchQuery = z.object({
  q: z
    .string({ error: "q is required" })
    .trim()
    .min(1, "q is required")
    .max(100, "q must be at most 100 characters"),
  limit: wholeNumber.pipe(z.number().max(50, "limit must be at most 50")).optional(),
});

/** Validates GET /api/v1/products query parameters: { q: trimmed 1 to 100 characters, limit: 1 to 50 }. */
export function productSearchRequest(query) {
  const data = parse(SearchQuery, withoutEmptyValues(query));

  return { q: data.q, limit: data.limit ?? DEFAULT_LIMIT };
}
