import { PERMISSIONS } from "../../services/auth/permissions.js";
import requirePermission from "./requirePermission.js";

/** Whoever may ring up a sale: the POS page, product lookup and checkout share this one gate. */
export default requirePermission(PERMISSIONS.SALES_CREATE);
