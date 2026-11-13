import { test } from "@japa/runner";
import { can, PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";

test.group("permissions", () => {
  test("PERMISSIONS holds exactly the twenty-three names", ({ expect }) => {
    expect(Object.values(PERMISSIONS).sort()).toEqual([
      "audit.view",
      "dashboard.view",
      "inventory.adjust",
      "inventory.approve",
      "inventory.manage",
      "inventory.receive",
      "inventory.view",
      "prescriptions.manage",
      "prescriptions.verify",
      "products.manage",
      "purchasing.approve",
      "purchasing.manage",
      "purchasing.view",
      "register.manage",
      "returns.approve",
      "returns.create",
      "sales.create",
      "sales.view.all",
      "sales.view.branch",
      "sales.view.own",
      "transfers.approve",
      "transfers.manage",
      "users.manage",
    ]);
  });

  test("transfers: admin and pharmacist manage them, only admin approves", ({ expect }) => {
    expect(ROLE_PERMISSIONS.admin).toContain("transfers.approve");
    expect(ROLE_PERMISSIONS.pharmacist).toContain("transfers.manage");
    expect(ROLE_PERMISSIONS.pharmacist).not.toContain("transfers.approve");
    expect(ROLE_PERMISSIONS.cashier).not.toContain("transfers.manage");
    expect(ROLE_PERMISSIONS.accountant).not.toContain("transfers.manage");
  });

  test("only admin may read the audit trail", ({ expect }) => {
    expect(ROLE_PERMISSIONS.admin).toContain("audit.view");
    for (const role of ["pharmacist", "cashier", "accountant"]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("audit.view");
    }
  });

  test("can is any-of and false for a null user", ({ expect }) => {
    expect(can({ permissions: ["a"] }, "a", "b")).toBe(true);
    expect(can({ permissions: ["x"] }, "a", "b")).toBe(false);
    expect(can({ permissions: [] }, "a")).toBe(false);
    expect(can(null, "a")).toBe(false);
  });

  test("the cashier role has exactly six permissions", ({ expect }) => {
    expect(ROLE_PERMISSIONS.cashier).toEqual([
      "dashboard.view",
      "sales.view.own",
      "sales.create",
      "register.manage",
      "returns.create",
      "prescriptions.manage",
    ]);
  });

  test("prescriptions: cashiers record them, only admin and pharmacist verify", ({ expect }) => {
    expect(ROLE_PERMISSIONS.cashier).toContain("prescriptions.manage");
    expect(ROLE_PERMISSIONS.cashier).not.toContain("prescriptions.verify");
    expect(ROLE_PERMISSIONS.pharmacist).toContain("prescriptions.verify");
    expect(ROLE_PERMISSIONS.admin).toContain("prescriptions.verify");
    expect(ROLE_PERMISSIONS.accountant).not.toContain("prescriptions.manage");
  });

  test("returns: everyone who sells may start one, only admin and pharmacist may approve", ({
    expect,
  }) => {
    expect(ROLE_PERMISSIONS.admin).toContain("returns.approve");
    expect(ROLE_PERMISSIONS.pharmacist).toContain("returns.approve");
    expect(ROLE_PERMISSIONS.pharmacist).toContain("returns.create");
    expect(ROLE_PERMISSIONS.cashier).not.toContain("returns.approve");
    expect(ROLE_PERMISSIONS.accountant).not.toContain("returns.create");
    expect(ROLE_PERMISSIONS.accountant).not.toContain("returns.approve");
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
      "returns.create",
      "returns.approve",
      "transfers.manage",
      "prescriptions.manage",
      "prescriptions.verify",
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
