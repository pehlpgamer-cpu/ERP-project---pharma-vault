import { PERMISSIONS } from "../auth/permissions.js";

/**
 * Which sales a user may see, from their permissions (the widest one wins):
 * `all` (every branch), `branch` (their branch; needs a branch), `own` (sales they rang up), `none`.
 * `branchId` is the user's branch, which a request for another branch is compared against.
 */
export function salesScope(user) {
  const granted = new Set(user?.permissions ?? []);
  const userId = user?.id ?? null;
  const branchId = user?.branchId ?? null;

  if (granted.has(PERMISSIONS.SALES_VIEW_ALL)) {
    return { level: "all", branchId: null, userId };
  }

  if (granted.has(PERMISSIONS.SALES_VIEW_BRANCH) && branchId !== null) {
    return { level: "branch", branchId, userId };
  }

  if (granted.has(PERMISSIONS.SALES_VIEW_OWN)) {
    return { level: "own", branchId, userId };
  }

  return { level: "none", branchId: null, userId };
}
