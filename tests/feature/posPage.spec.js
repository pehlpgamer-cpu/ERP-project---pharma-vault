import { readFile } from "node:fs/promises";
import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeOpenSession,
  makeRegister,
  makeUser,
  makeWorld,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";
const POS_SCRIPT = new URL("../../public/js/pos.js", import.meta.url);
const CART_SCRIPT = new URL("../../public/js/pos-cart.js", import.meta.url);

test.group("POS page", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a cashier with an open register gets the sales screen and its configuration", async ({
    expect,
  }) => {
    const world = await makeWorld();
    const session = await loginAs(world.cashier);

    const response = await session.get("/pos-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain('id="pos-root"');
    expect(response.text).toContain("data-config=");
    expect(response.text).toContain("/api/v1/products");
    expect(response.text).toContain("/api/v1/sales");
    expect(response.text).toContain('src="/js/pos.js"');
    expect(response.text).toContain('type="module"');
    expect(response.text).toContain(world.register.name);
    expect(response.text).toContain('id="pos-search"');
  });

  test("a cashier without an open register is sent to the register page with a message", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const cashier = await makeUser({
      branchId: branch.id,
      roleName: "cashier-pos",
      permissions: ROLE_PERMISSIONS.cashier,
    });
    await makeRegister({ branchId: branch.id });
    const session = await loginAs(cashier);

    const response = await session.get("/pos-page", HTML);
    const page = await session.get("/cash-register-page", HTML);

    expect([response.status, response.location]).toEqual([302, "/cash-register-page"]);
    expect(page.text).toContain("Open a register first");
  });

  test("an accountant is denied and a signed-out visitor is sent to log in", async ({ expect }) => {
    const branch = await makeBranch();
    const accountant = await loginAs(
      await makeUser({
        branchId: branch.id,
        roleName: "accountant-pos",
        permissions: ROLE_PERMISSIONS.accountant,
      }),
    );

    const denied = await accountant.get("/pos-page", HTML);
    const anonymous = await new TestSession().get("/pos-page", HTML);

    expect(denied.status).toBe(403);
    expect([anonymous.status, anonymous.location]).toEqual([302, "/login-page"]);
  });

  test("the register name on the page is escaped", async ({ expect }) => {
    const branch = await makeBranch();
    const cashier = await makeUser({
      branchId: branch.id,
      roleName: "cashier-pos",
      permissions: ROLE_PERMISSIONS.cashier,
    });
    const register = await makeRegister({ branchId: branch.id, name: XSS });
    await makeOpenSession({ registerId: register.id, cashierId: cashier.id });
    const session = await loginAs(cashier);

    const response = await session.get("/pos-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).not.toContain("<img src=x");
    expect(response.text).toContain("&lt;img");
  });

  test("the scripts are served as JavaScript", async ({ expect }) => {
    for (const path of ["/js/pos.js", "/js/pos-cart.js"]) {
      const response = await new TestSession().get(path);

      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("content-type")).toMatch(/javascript/);
    }
  });
});

test.group("POS scripts (review focus 5)", () => {
  test("pos.js never writes markup: no innerHTML, outerHTML, insertAdjacentHTML or document.write", async ({
    expect,
  }) => {
    const source = await readFile(POS_SCRIPT, "utf8");

    for (const forbidden of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
    ]) {
      expect([forbidden, source.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("the scripts are static files: no Handlebars mustaches", async ({ expect }) => {
    for (const url of [POS_SCRIPT, CART_SCRIPT]) {
      expect((await readFile(url, "utf8")).includes("{{")).toBe(false);
    }
  });

  test("pos-cart.js has no imports and touches no DOM", async ({ expect }) => {
    const source = await readFile(CART_SCRIPT, "utf8");

    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\b(document|window|sessionStorage|localStorage)\b/);
  });
});
