import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { recordAudit } from "../../app/services/audit/auditLog.js";
import { hashPassword, verifyPassword } from "../../app/services/auth/passwords.js";
import {
  createUser,
  findUserByEmail,
  listUsers,
  loadAuthUser,
} from "../../app/services/auth/users.js";
import { requestMeta } from "../../app/http/support/requestMeta.js";
import { resetDatabase } from "../helpers/db.js";
import { assignRole, makeBranch, makeUser } from "../helpers/factories.js";

const LONG_PASSWORD = "x".repeat(14);

test.group("passwords", () => {
  test("hashPassword produces an argon2id hash that verifies", async ({ expect }) => {
    const hash = await hashPassword(LONG_PASSWORD);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, LONG_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, "y".repeat(14))).toBe(false);
  });

  test("verifyPassword is false for a missing or malformed hash", async ({ expect }) => {
    expect(await verifyPassword(null, "anything")).toBe(false);
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

test.group("user services", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("createUser stores an active user with no roles and a hashed password", async ({
    expect,
  }) => {
    const created = await createUser({ name: "Ana", email: "a@x.test", password: LONG_PASSWORD });
    const row = await findUserByEmail("a@x.test");

    expect(created.id).toBe(row.id);
    expect(row.isActive).toBe(true);
    expect(row.branchId).toBeNull();
    expect(row.password.startsWith("$argon2id$")).toBe(true);
  });

  test("createUser returns null for a duplicate email in any case", async ({ expect }) => {
    await createUser({ name: "Ana", email: "a@x.test", password: LONG_PASSWORD });

    const duplicate = await createUser({
      name: "Ana 2",
      email: "A@X.TEST",
      password: LONG_PASSWORD,
    });

    expect(duplicate).toBeNull();
  });

  test("findUserByEmail ignores case", async ({ expect }) => {
    await createUser({ name: "Ana", email: "a@x.test", password: LONG_PASSWORD });

    expect((await findUserByEmail("A@X.TEST")).email).toBe("a@x.test");
    expect(await findUserByEmail("nobody@x.test")).toBeNull();
  });

  test("loadAuthUser returns branch, role names and flattened permissions", async ({ expect }) => {
    const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
    const user = await makeUser({
      branchId: branch.id,
      roleName: "cashier",
      permissions: ["sales.create", "dashboard.view"],
    });

    const authUser = await loadAuthUser(user.id);

    expect(authUser).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      branchId: branch.id,
      branchCode: "MAIN",
      branchName: "Main Branch",
      roles: ["cashier"],
      permissions: ["dashboard.view", "sales.create"],
    });
  });

  test("loadAuthUser lists a permission once when two roles grant it", async ({ expect }) => {
    const user = await makeUser({ roleName: "first", permissions: ["sales.create"] });
    await assignRole(user.id, "second", ["sales.create", "dashboard.view"]);

    const authUser = await loadAuthUser(user.id);

    expect(authUser.roles).toEqual(["first", "second"]);
    expect(authUser.permissions).toEqual(["dashboard.view", "sales.create"]);
  });

  test("loadAuthUser is null for an inactive user and for an unknown id", async ({ expect }) => {
    const inactive = await makeUser({ isActive: false });

    expect(await loadAuthUser(inactive.id)).toBeNull();
    expect(await loadAuthUser("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("listUsers returns role names and branch name", async ({ expect }) => {
    const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
    await makeUser({ name: "Ana", branchId: branch.id, roleName: "cashier" });
    await makeUser({ name: "Zed" });

    const list = await listUsers();

    expect(list.map((user) => user.name)).toEqual(["Ana", "Zed"]);
    expect(list[0]).toMatchObject({
      branchName: "Main Branch",
      roles: ["cashier"],
      isActive: true,
    });
    expect(list[1].branchName).toBeNull();
  });
});

test.group("audit log", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("recordAudit stores the action, user and JSON values", async ({ expect }) => {
    const user = await makeUser();

    await recordAudit(db, {
      userId: user.id,
      action: "LOGIN_SUCCESS",
      entityType: "user",
      entityId: user.id,
      newValues: { email: user.email },
      ipAddress: "10.0.0.1",
    });
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.userId, user.id));

    expect(row.action).toBe("LOGIN_SUCCESS");
    expect(row.newValues).toEqual({ email: user.email });
    expect(row.oldValues).toBeNull();
    expect(row.ipAddress).toBe("10.0.0.1");
  });

  test("requestMeta reads the address and user agent and caps the address length", ({ expect }) => {
    const req = {
      ip: `::ffff:${"1".repeat(60)}`,
      get(name) {
        return name === "user-agent" ? "TestAgent/1.0" : undefined;
      },
    };

    const meta = requestMeta(req);

    expect(meta.userAgent).toBe("TestAgent/1.0");
    expect(meta.ipAddress).toHaveLength(45);
    expect(requestMeta({ get: () => undefined })).toEqual({ ipAddress: null, userAgent: null });
  });
});
