import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };

test.group("application shell", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("the home page links to the login page when signed out", async ({ expect }) => {
    const response = await new TestSession().get("/", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain('href="/login-page"');
  });

  test("the home page sends a signed-in user to the dashboard", async ({ expect }) => {
    const session = await loginAs(await makeUser());
    const response = await session.get("/", HTML);

    expect([response.status, response.location]).toEqual([302, "/dashboard-page"]);
  });

  test("the sidebar follows the permissions of the signed-in user", async ({ expect }) => {
    const cashier = await loginAs(
      await makeUser({ roleName: "cashier", permissions: ROLE_PERMISSIONS.cashier }),
    );
    const admin = await loginAs(
      await makeUser({ roleName: "admin", permissions: ROLE_PERMISSIONS.admin }),
    );

    const cashierPage = await cashier.get("/dashboard-page", HTML);
    const adminPage = await admin.get("/dashboard-page", HTML);

    expect(cashierPage.status).toBe(200);
    expect(cashierPage.text).toContain('href="/sales"');
    expect(cashierPage.text).toContain('href="/pos-page"');
    expect(cashierPage.text).toContain('href="/cash-register-page"');
    expect(cashierPage.text).not.toContain('href="/users"');
    expect(cashierPage.text).toMatch(/<form[^>]*action="\/logout"/);
    expect(adminPage.text).toContain('href="/users"');
  });

  test("a user without permissions sees only the dashboard link", async ({ expect }) => {
    const session = await loginAs(await makeUser());
    const response = await session.get("/dashboard-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('href="/sales"');
    expect(response.text).not.toContain('href="/pos-page"');
  });

  test("a failed login shows its message as a flash meta tag", async ({ expect }) => {
    const session = new TestSession();

    await session.post("/login", { form: { email: "nobody@pharmavault.test", password: "x" } });
    const page = await session.get("/login-page", HTML);

    expect(page.text).toContain('<meta name="flash-error" content="Invalid email or password">');
  });

  test("a signed-in 404 renders inside the authenticated layout", async ({ expect }) => {
    const session = await loginAs(await makeUser());
    const response = await session.get("/nope", HTML);

    expect(response.status).toBe(404);
    expect(response.text).toContain("Page not found");
    expect(response.text).toContain('aria-label="Main"');
  });

  test("a signed-out 404 has no side navigation", async ({ expect }) => {
    const response = await new TestSession().get("/nope", HTML);

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('aria-label="Main"');
  });

  test("the auth pages link to the real page routes and load SweetAlert2", async ({ expect }) => {
    const session = new TestSession();
    const login = await session.get("/login-page", HTML);
    const register = await session.get("/register-page", HTML);
    const forgot = await session.get("/forgot-password-page", HTML);

    expect(login.text).toContain('href="/register-page"');
    expect(register.text).toContain('href="/login-page"');
    expect(forgot.text).toContain('href="/login-page"');
    expect(login.text).toContain("sweetalert2@11");
    expect(login.text).not.toContain('href="/register"');
  });
});
