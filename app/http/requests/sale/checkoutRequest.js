import * as z from "zod";
import { cmp, isDecimal, toScale } from "../../../services/support/decimal.js";
import { parse } from "../validate.js";

const PAYMENT_METHODS = ["CASH", "CARD", "GCASH", "MAYA", "BANK_TRANSFER", "OTHER"];
const MAX_LINES = 50;
const MAX_PAYMENTS = 10;

// Quantities and amounts are exact decimals sent as strings ("2", "10.50"): a JSON number would
// already be a float. At most 12 whole digits and the stated number of decimals, more than zero.
const positive = (label, decimals) => {
  const pattern = new RegExp(`^\\d{1,12}(\\.\\d{1,${decimals}})?$`);

  return z
    .string({ error: `${label} must be given as a string such as "2"` })
    .trim()
    .regex(pattern, `${label} must be a number with at most ${decimals} decimals`)
    .refine((value) => {
      // checks continue after a failed one, so this must cope with text that is not a number
      return isDecimal(value) && cmp(value, "0") > 0;
    }, `${label} must be more than zero`)
    .transform((value) => {
      return toScale(value, decimals);
    });
};

const Line = z.object({
  productUnitId: z.uuid({ error: "productUnitId must be a UUID" }),
  quantity: positive("quantity", 3),
});

const Payment = z.object({
  method: z.enum(PAYMENT_METHODS, { error: `method must be one of ${PAYMENT_METHODS.join(", ")}` }),
  amount: positive("amount", 2),
  reference: z
    .string({ error: "reference must be text" })
    .trim()
    .max(150, "reference must be at most 150 characters")
    .nullish()
    .transform((value) => {
      return value ? value : null;
    }),
});

const Checkout = z.object({
  items: z
    .array(Line, { error: "items must be a list" })
    .min(1, "Add at least one item")
    .max(MAX_LINES, `A sale can have at most ${MAX_LINES} lines`),
  payments: z
    .array(Payment, { error: "payments must be a list" })
    .min(1, "Add at least one payment")
    .max(MAX_PAYMENTS, `A sale can have at most ${MAX_PAYMENTS} payments`),
  customerId: z
    .uuid({ error: "customerId must be a UUID" })
    .nullish()
    .transform((value) => {
      return value ?? null;
    }),
});

/**
 * Validates the body of POST /api/v1/sales and normalizes it for createSale: quantities with three
 * decimals, amounts with two, references trimmed (or null). Throws ValidationError.
 */
export function checkoutRequest(body) {
  return parse(Checkout, body);
}
