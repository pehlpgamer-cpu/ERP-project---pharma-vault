import * as z from "zod";

/** A whole number from a query string ("25"): digits only, at least 1. */
export const wholeNumber = z
  .string()
  .regex(/^\d+$/, "Must be a whole number")
  .transform(Number)
  .pipe(z.number().int().min(1));

/** `?q=&status=` means "not given", exactly like leaving the parameter out. */
export function withoutEmptyValues(query) {
  return Object.fromEntries(
    Object.entries(query ?? {}).filter(([, value]) => {
      return value !== "";
    }),
  );
}
