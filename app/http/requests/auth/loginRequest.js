import * as z from "zod";
import { parse } from "../validate.js";

const Login = z.object({
  email: z.email().max(255),
  password: z.string().min(1).max(128),
});

/**
 * Validates the login form body. Throws ValidationError. The password is never trimmed.
 * @param {object} body
 * @returns {{ email: string, password: string }}
 */
export function loginRequest(body) {
  const email = typeof body?.email === "string" ? body.email.trim() : body?.email;

  return parse(Login, { email, password: body?.password });
}
