import * as z from "zod";
import { wholeNumber, withoutEmptyValues } from "../fields.js";
import { parse } from "../validate.js";

const Query = z.object({
  q: z.string().max(100, "Search text must be at most 100 characters").optional(),
  status: z
    .enum(["active", "inactive", "any"], { error: "Status must be active, inactive or any" })
    .optional(),
  categoryId: z.uuid({ error: "Unknown category" }).optional(),
  page: wholeNumber.optional(),
});

/** Validates GET /products query parameters and applies the defaults (active products, page 1). */
export function productListRequest(query) {
  const data = parse(Query, withoutEmptyValues(query));

  return {
    q: data.q,
    status: data.status ?? "active",
    categoryId: data.categoryId,
    page: data.page ?? 1,
  };
}
