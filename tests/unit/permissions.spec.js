import { test } from "@japa/runner";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";

test.group("permissions", () => {
  test("PERMISSIONS holds exactly the sixteen names", ({ expect }) => {
    expect(Object.values(PERMISSIONS).sort()).toEqual([
      "dashboard.view",
      "inventory.adjust",
      "inventory.approve",
      "inventory.manage",
      "inventory.receive",
      "inventory.view",
      "products.manage",
      "purchasing.approve",
      "purchasing.manage",
      "purchasing.view",
      "register.manage",
      "sales.create",
      "sales.view.all",
      "sales.view.branch",
      "sales.view.own",
      "users.manage",
    ]);
  });

  test("can is any-of and false for a null user", ({ expect }) => {
    expect(can({ permissions: ["a"] }, "a", "b")).toBe(true);
    expect(can({ permissions: ["x"] }, "a", "b")).toBe(false);
    expect(can({ permissions: [] }, "a")).toBe(false);
    expect(can(null, "a")).toBe(false);
  });

  test("the cashier role has exactly four permissions", ({ expect }) => {
    expect(ROLE_PERMISSIONS.cashier).toEqual([
      "dashboard.view",
      "sales.view.own",
      "sales.create",
      "register.manage",
    ]);
  });

  test("only admin and pharmacist may manage products", ({ expect }) => {
    expect(PERMISSIONS.PRODUCTS_MANAGE).toBe("products.manage");
    expect(ROLE_PERMISSIONS.admin).toContain("products.manage");
    expect(ROLE_PERMISSIONS.pharmacist).toContain("products.manage");
    expect(ROLE_PERMISSIONS.cashier).not.toContain("products.manage");
    expect(ROLE_PERMISSIONS.accountant).not.toContain("products.manage");
  });

  test("the admin role has every permission", ({ expect }) => {
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  test("pharmacist and accountant match the role table", ({ expect }) => {
    expect(ROLE_PERMISSIONS.pharmacist).toEqual([
      "dashboard.view",
      "sales.view.branch",
      "sales.create",
      "register.manage",
      "products.manage",
      "inventory.view",
      "inventory.manage",
      "inventory.receive",
      "inventory.adjust",
      "purchasing.view",
      "purchasing.manage",
    ]);
    expect(ROLE_PERMISSIONS.admin).toContain("inventory.approve");
    expect(ROLE_PERMISSIONS.pharmacist).not.toContain("inventory.approve");
    expect(ROLE_PERMISSIONS.accountant).toEqual([
      "dashboard.view",
      "sales.view.all",
      "inventory.view",
      "purchasing.view",
    ]);
    expect(ROLE_PERMISSIONS.cashier).not.toContain("inventory.view");
  });
});
