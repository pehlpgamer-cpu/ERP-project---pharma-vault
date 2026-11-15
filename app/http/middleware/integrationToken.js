import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors.js";

const digest = (value) => {
  return createHash("sha256").update(value).digest();
};

// Reads `Authorization: Bearer <token>` or `X-API-Key: <token>`.
function presentedToken(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "");

  return bearer ? bearer[1].trim() : (req.get("x-api-key") ?? "").trim();
}

/**
 * Guards the read-only endpoints other systems call. They present a shared secret
 * (INTEGRATION_API_TOKEN); there is no user session. With no token configured the endpoints are
 * switched off (503), never open.
 */
export default function integrationToken(req, res, next) {
  const expected = process.env.INTEGRATION_API_TOKEN;

  if (!expected) {
    return next(new HttpError(503, "integration_disabled", "Integration API is not enabled"));
  }

  const presented = presentedToken(req);

  // hashing first makes both sides the same length, so the comparison leaks nothing about the token
  if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
    return next(new HttpError(401, "unauthenticated", "A valid integration token is required"));
  }

  return next();
}
