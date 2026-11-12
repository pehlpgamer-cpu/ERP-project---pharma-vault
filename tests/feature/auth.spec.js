import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { users } from "../../app/models/users.js";
import { findUserByEmail, loadAuthUser } from "../../app/services/auth/users.js";
import { resetDatabase } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

async function auditActions() {
  const rows = await db.select().from(auditLogs);

  return rows.map((row) => {
    return row.action;
  });
}

test.group("login", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a valid login redirects to the dashboard with a hardened session cookie", async ({
    expect,
  }) => {
    const user = await makeUser();
    const response = await new TestSession().post("/login", {
      form: { email: user.email, password: user.password },
    });
    const cookie = response.headers.getSetCookie().find((line) => {
      return line.startsWith("pv.sid=");
    });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "LOGIN_SUCCESS"));

    expect([response.status, response.location]).toEqual([302, "/dashboard-page"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(audit.userId).toBe(user.id);
  });

  test("wrong password, unknown email and inactive user fail identically and are audited", async ({
    expect,
  }) => {
    const active = await makeUser();
    const inactive = await makeUser({ isActive: false });
    const attempts = [
      { email: active.email, password: "wrong-password-123" },
      { email: "nobody@pharmavault.test", password: "wrong-password-123" },
      { email: inactive.email, password: inactive.password },
    ];
    const results = [];

    for (const form of attempts) {
      const response = await new TestSession().post("/login", { form });
      results.push([response.status, response.location]);
    }

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "LOGIN_FAILED"));

    expect(results).toEqual([
      [302, "/login-page"],
      [302, "/login-page"],
      [302, "/login-page"],
    ]);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain("wrong-password-123");
  });

  test("an invalid login body is a redirect, never a 500", async ({ expect }) => {
    const response = await new TestSession().post("/login", { form: {} });

    expect([response.status, response.location]).toEqual([302, "/login-page"]);
  });

  test("login returns to the page that required it", async ({ expect }) => {
    const user = await makeUser();
    const session = new TestSession();

    const first = await session.get("/dashboard-page?x=1");
    const second = await session.post("/login", {
      form: { email: user.email, password: user.password },
    });

    expect([first.status, first.location]).toEqual([302, "/login-page"]);
    expect([second.status, second.location]).toEqual([302, "/dashboard-page?x=1"]);
  });

  test("a deactivated user is signed out on the next request", async ({ expect }) => {
    const user = await makeUser();
    const session = await loginAs(user);

    expect((await session.get("/dashboard-page")).status).toBe(200);
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    const after = await session.get("/dashboard-page");

    expect([after.status, after.location]).toEqual([302, "/login-page"]);
  });
});

test.group("logout", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("POST /logout destroys the session on the server and is audited", async ({ expect }) => {
    const user = await makeUser();
    const session = await loginAs(user);
    const oldCookie = session.cookie("pv.sid");

    const response = await session.post("/logout");
    const stale = new TestSession();
    stale.setCookie("pv.sid", oldCookie);
    const replay = await stale.get("/dashboard-page");

    expect([response.status, response.location]).toEqual([302, "/login-page"]);
    expect([replay.status, replay.location]).toEqual([302, "/login-page"]);
    expect(await auditActions()).toContain("LOGOUT");
  });

  test("GET /logout no longer exists", async ({ expect }) => {
    const response = await new TestSession().get("/logout", { headers: { accept: "text/html" } });

    expect(response.status).toBe(404);
  });
});

test.group("register", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  const valid = {
    name: "Ana Reyes",
    email: "ana@pharmavault.test",
    password: "a-long-enough-password",
  };

  test("a valid registration creates an active user with no roles", async ({ expect }) => {
    const response = await new TestSession().post("/register", { form: valid });
    const created = await findUserByEmail(valid.email);

    expect([response.status, response.location]).toEqual([302, "/login-page"]);
    expect(created.isActive).toBe(true);
    expect((await loadAuthUser(created.id)).roles).toEqual([]);
    expect(await auditActions()).toContain("USER_REGISTERED");
  });

  test("duplicate email, short password and empty body redirect back without a 500", async ({
    expect,
  }) => {
    await makeUser({ email: valid.email });
    const attempts = [
      valid,
      { ...valid, email: "other@pharmavault.test", password: "1234567890123" },
      {},
    ];
    const results = [];

    for (const form of attempts) {
      const response = await new TestSession().post("/register", { form });
      results.push([response.status, response.location]);
    }

    expect(results).toEqual([
      [302, "/register-page"],
      [302, "/register-page"],
      [302, "/register-page"],
    ]);
    expect(await findUserByEmail("other@pharmavault.test")).toBeNull();
  });
});
