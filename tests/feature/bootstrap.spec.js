import { test } from "@japa/runner";
import { count, eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { runBootstrap } from "../../database/seed/bootstrap.js";
import { branches } from "../../app/models/branches.js";
import { cashRegisters } from "../../app/models/cash-registers.js";
import { permissions } from "../../app/models/permissions.js";
import { rolePermissions } from "../../app/models/role-permissions.js";
import { roles } from "../../app/models/roles.js";
import { userRoles } from "../../app/models/user-roles.js";
import { users } from "../../app/models/users.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { verifyPassword } from "../../app/services/auth/passwords.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { resetDatabase } from "../helpers/db.js";

const OPTIONS = {
  adminEmail: "owner@pharmacy.example",
  adminName: "Olivia Owner",
  adminPassword: "a-long-enough-password",
  branchCode: "MAIN",
  branchName: "Main Branch",
  log: () => {},
};

const total = async (table) => {
  const [{ n }] = await db.select({ n: count() }).from(table);

  return Number(n);
};

test.group("production bootstrap", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a fresh database gets permissions, roles, a branch, a register and an admin who can sign in", async ({
    expect,
  }) => {
    await runBootstrap(OPTIONS);

    const [admin] = await db.select().from(users).where(eq(users.email, OPTIONS.adminEmail));
    const loaded = await loadAuthUser(admin.id);

    expect(await total(permissions)).toBe(Object.values(PERMISSIONS).length);
    expect(await total(roles)).toBe(Object.keys(ROLE_PERMISSIONS).length);
    expect(await total(branches)).toBe(1);
    expect(await total(cashRegisters)).toBe(1);
    expect(await verifyPassword(admin.password, OPTIONS.adminPassword)).toBe(true);
    expect(loaded.roles).toContain("admin");
    expect(loaded.branchCode).toBe("MAIN");
    expect([...loaded.permissions].sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  test("running it again changes nothing, keeps the admin's password and repairs missing links", async ({
    expect,
  }) => {
    await runBootstrap(OPTIONS);

    const [before] = await db.select().from(users);
    const linksBefore = await total(rolePermissions);

    // a permission link lost (or never granted, as after an upgrade), and a different password offered
    await db
      .delete(rolePermissions)
      .where(
        eq(
          rolePermissions.permissionId,
          (
            await db.select().from(permissions).where(eq(permissions.name, PERMISSIONS.AUDIT_VIEW))
          )[0].id,
        ),
      );
    await runBootstrap({ ...OPTIONS, adminPassword: "another-long-password-1" });

    const [after] = await db.select().from(users);

    expect(await total(users)).toBe(1);
    expect(await total(branches)).toBe(1);
    expect(await total(cashRegisters)).toBe(1);
    expect(await total(permissions)).toBe(Object.values(PERMISSIONS).length);
    expect(await total(rolePermissions)).toBe(linksBefore);
    expect(await total(userRoles)).toBe(1);
    expect(after.password).toBe(before.password);
  });

  test("an existing account of that email is promoted to admin, not replaced", async ({
    expect,
  }) => {
    await runBootstrap(OPTIONS);
    await db.delete(userRoles);
    await runBootstrap(OPTIONS);

    expect(await total(users)).toBe(1);
    expect(await total(userRoles)).toBe(1);
  });

  test("weak or malformed input is refused before anything is written", async ({ expect }) => {
    for (const bad of [
      { adminPassword: "short" },
      { adminEmail: "not-an-email" },
      { adminEmail: "" },
      { adminName: " " },
      { branchCode: "bad code!" },
      { branchCode: "" },
    ]) {
      await expect(runBootstrap({ ...OPTIONS, ...bad })).rejects.toThrow();
    }

    expect(await total(users)).toBe(0);
    expect(await total(permissions)).toBe(0);
  });
});
