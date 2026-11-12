import { HttpError } from "../errors.js";
import wantsJson from "../support/wantsJson.js";

/**
 * Lets signed-in users through. API clients get a 401 envelope; browsers are sent to the login
 * page, which remembers a GET target so the user lands back where they started.
 */
export default function requireAuth(req, res, next) {
  if (req.user) {
    return next();
  }

  if (wantsJson(req)) {
    return next(new HttpError(401, "unauthenticated", "Authentication required"));
  }

  if (req.method === "GET" && req.session) {
    req.session.returnTo = req.originalUrl;
  }

  req.flash("error_msg", "Please sign in");

  return res.redirect("/login-page");
}
