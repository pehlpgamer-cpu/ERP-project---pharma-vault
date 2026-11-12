import { asc, eq } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { branches } from "../../models/branches.js";
import { sales } from "../../models/sales.js";
import { users } from "../../models/users.js";
import { salesScope } from "./scope.js";

/**
 * The values for the branch and cashier selectors of the sales filter form. Branches are offered
 * only to users who may see every branch; cashiers (people who rang up sales) to users who may see
 * a whole branch or every branch. A user who only sees their own sales gets neither.
 */
export async function loadFilterOptions(user) {
  const scope = salesScope(user);
  const options = { branches: [], cashiers: [] };

  if (scope.level === "all") {
    options.branches = await db
      .select({ id: branches.id, code: branches.code, name: branches.name })
      .from(branches)
      .orderBy(asc(branches.name));
  }

  if (scope.level === "all" || scope.level === "branch") {
    options.cashiers = await db
      .selectDistinct({ id: users.id, name: users.name })
      .from(sales)
      .innerJoin(users, eq(users.id, sales.cashierId))
      .where(scope.level === "branch" ? eq(sales.branchId, scope.branchId) : undefined)
      .orderBy(asc(users.name));
  }

  return options;
}
