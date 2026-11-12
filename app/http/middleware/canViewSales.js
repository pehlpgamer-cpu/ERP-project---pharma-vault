import { PERMISSIONS } from "../../services/auth/permissions.js";
import requirePermission from "./requirePermission.js";

/**
 * Any role that may see at least its own sales. The sales query service narrows what each role
 * actually gets (own, branch or all), so web pages and the API share this one gate.
 */
export default requirePermission(
  PERMISSIONS.SALES_VIEW_OWN,
  PERMISSIONS.SALES_VIEW_BRANCH,
  PERMISSIONS.SALES_VIEW_ALL,
);
