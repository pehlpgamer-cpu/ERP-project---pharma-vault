import { ValidationError } from "../errors.js";

/**
 * Parses `input` with a zod schema. Returns the parsed data, or throws a ValidationError whose
 * details are `{ path, message }` with dotted paths ("items.0.quantity").
 */
export function parse(schema, input) {
  const result = schema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  throw new ValidationError(
    result.error.issues.map((issue) => {
      return { path: issue.path.map(String).join("."), message: issue.message };
    }),
  );
}
