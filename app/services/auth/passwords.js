import * as argon2 from "argon2";
import { argon2Config } from "../../../config/cryptography.js";

let dummyHash = null;

export async function hashPassword(plain) {
  return argon2.hash(plain, argon2Config);
}

/**
 * Verifies a password against a stored hash. When there is no usable hash (unknown user) it still
 * performs a verification against a dummy hash, so the response time does not reveal whether the
 * account exists. Never throws; any failure is "false".
 */
export async function verifyPassword(hash, plain) {
  if (typeof hash !== "string" || !hash.startsWith("$argon2")) {
    dummyHash ??= await argon2.hash("dummy password used only for timing", argon2Config);
    await argon2.verify(dummyHash, String(plain)).catch(() => {
      return false;
    });

    return false;
  }

  try {
    return await argon2.verify(hash, String(plain));
  } catch {
    return false;
  }
}
