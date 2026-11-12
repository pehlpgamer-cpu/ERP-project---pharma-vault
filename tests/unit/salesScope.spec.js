import { test } from "@japa/runner";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { salesScope } from "../../app/services/sales/scope.js";

const user = (permissions, branchId = "branch-1") => {
  return { id: "user-1", branchId, permissions };
};

test.group("salesScope", () => {
  test("admin and accountant see every branch", ({ expect }) => {
    expect(salesScope(user(ROLE_PERMISSIONS.admin)).level).toBe("all");
    expect(salesScope(user(ROLE_PERMISSIONS.accountant, null)).level).toBe("all");
  });

  test("a pharmacist sees their branch", ({ expect }) => {
    expect(salesScope(user(ROLE_PERMISSIONS.pharmacist))).toEqual({
      level: "branch",
      branchId: "branch-1",
      userId: "user-1",
    });
  });

  test("a branch scope without a branch resolves to none", ({ expect }) => {
    expect(salesScope(user(ROLE_PERMISSIONS.pharmacist, null)).level).toBe("none");
  });

  test("a cashier sees only their own sales", ({ expect }) => {
    expect(salesScope(user(ROLE_PERMISSIONS.cashier))).toEqual({
      level: "own",
      branchId: "branch-1",
      userId: "user-1",
    });
  });

  test("no sales permission means none", ({ expect }) => {
    expect(salesScope(user([PERMISSIONS.DASHBOARD_VIEW])).level).toBe("none");
    expect(salesScope(user([])).level).toBe("none");
  });

  test("the widest permission wins", ({ expect }) => {
    expect(salesScope(user([PERMISSIONS.SALES_VIEW_OWN, PERMISSIONS.SALES_VIEW_ALL])).level).toBe(
      "all",
    );
    expect(
      salesScope(user([PERMISSIONS.SALES_VIEW_OWN, PERMISSIONS.SALES_VIEW_BRANCH])).level,
    ).toBe("branch");
  });
});
