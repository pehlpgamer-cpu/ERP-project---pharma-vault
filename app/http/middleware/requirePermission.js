import { can } from "../../services/auth/permissions.js";
import { HttpError } from "../errors.js";

/** Passes when the user holds at least one of the named permissions; otherwise a 403. */
export default function requirePermission(...names) {
  return function checkPermission(req, res, next) {
    if (can(req.user, ...names)) {
      return next();
    }

    return next(new HttpError(403, "forbidden", "You do not have access"));
  };
}
