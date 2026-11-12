import { loadAuthUser } from "../../services/auth/users.js";
import { regenerateSession } from "../support/session.js";

/**
 * Resolves the signed-in user on every request: sets `req.user` (or null) and the template
 * variables `currentUser` (or null) and `currentPath`. A session whose user was deleted or
 * deactivated is replaced by a fresh empty one, so access ends on the very next request and
 * later middleware (flash messages) still has a session to work with.
 */
export default async function loadUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;
  res.locals.currentPath = req.path;

  const userId = req.session?.userId;

  if (userId) {
    const user = await loadAuthUser(userId);

    if (user) {
      req.user = user;
      res.locals.currentUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        branchName: user.branchName,
        roles: user.roles,
        permissions: user.permissions,
      };
    } else {
      await regenerateSession(req);
    }
  }

  next();
}
