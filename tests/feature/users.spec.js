import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };

test.group("users page", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("an admin sees every user with roles and branch, with names escaped", async ({ expect }) => {
    const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
    const admin = await loginAs(
      await makeUser({
        roleName: "admin",
        permissions: ROLE_PERMISSIONS.admin,
        branchId: branch.id,
      }),
    );
    await makeUser({ name: "<b>x</b>", roleName: "cashier", branchId: branch.id });

    const response = await admin.get("/users", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(response.text).not.toContain("<b>x</b>");
    expect(response.text).toContain("cashier");
    expect(response.text).toContain("Main Branch");
  });

  test("a cashier is denied", async ({ expect }) => {
    const cashier = await loginAs(
      await makeUser({ roleName: "cashier", permissions: ROLE_PERMISSIONS.cashier }),
    );

    const response = await cashier.get("/users", HTML);

    expect(response.status).toBe(403);
    expect(response.text).toContain("Access denied");
  });

  test("a signed-out visitor is sent to the login page", async ({ expect }) => {
    const response = await new TestSession().get("/users", HTML);

    expect([response.status, response.location]).toEqual([302, "/login-page"]);
  });

  test("unfinished resource routes are not registered", async ({ expect }) => {
    const admin = await loginAs(
      await makeUser({ roleName: "admin", permissions: ROLE_PERMISSIONS.admin }),
    );

    for (const path of ["/users/create", "/users/some-id", "/audit-trail"]) {
      const response = await admin.get(path, HTML);

      expect([path, response.status]).toEqual([path, 404]);
    }
  });
});
