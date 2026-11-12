import * as z from "zod";

/**
 * True for a well-formed UUID. Ids reach the database as parameters of ASCII columns, so anything else
 * (including non-ASCII text) is rejected before a query instead of surfacing as a MySQL error.
 */
export function isUuid(value) {
  return z.uuid().safeParse(value).success;
}
