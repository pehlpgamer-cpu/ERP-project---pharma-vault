import * as z from "zod";
import { parse } from "../validate.js";

const Register = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().max(255),
  password: z.string().min(14).max(128),
});

/**
 * Validates the registration form body. Throws ValidationError. The password is never trimmed.
 * @param {object} body
 * @returns {{ name: string, email: string, password: string }}
 */
export function registerRequest(body) {
  const email = typeof body?.email === "string" ? body.email.trim() : body?.email;

  return parse(Register, { name: body?.name, email, password: body?.password });
}
