import { test } from "@japa/runner";
import { db } from "../../database/client.js";
import { cashRegisterSessions } from "../../app/models/cash-register-sessions.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { openSession } from "../../app/services/register/registerSessions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeCashTransaction,
  makeRegister,
  makeUser,
  makeWorld,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

async function branchWithCounter({ counterName = "Counter One" } = {}) {
  const branch = await makeBranch({ code: "MAIN", name: "Main Branch" });
  const register = await makeRegister({ branchId: branch.id, name: counterName, code: "C1" });
  const user = await makeUser({
    branchId: branch.id,
    roleName: "cashier-page",
    permissions: ROLE_PERMISSIONS.cashier,
    name: "Ana Reyes",
  });

  return { branch, register, user, session: await loginAs(user) };
}

function sessions() {
  return db.select().from(cashRegisterSessions);
}

const OPEN_FORM = 'action="/cash-register/open"';
const CLOSE_FORM = 'action="/cash-register/close"';

test.group("cash register page", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("lists the branch's free registers in an open form", async ({ expect }) => {
    const { branch, session } = await branchWithCounter();
    const other = await makeBranch({ code: "NORTH" });
    await makeRegister({ branchId: other.id, name: "North counter" });
    await makeRegister({ branchId: branch.id, name: "Old counter", isActive: false });

    const response = await session.get("/cash-register-page", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain(OPEN_FORM);
    expect(response.text).toContain('name="registerId"');
    expect(response.text).toContain('name="openingCash"');
    expect(response.text).toContain("Counter One");
    expect(response.text).not.toContain("North counter");
    expect(response.text).not.toContain("Old counter");
    expect(response.text).not.toContain(CLOSE_FORM);
  });

  test("says so when every register is taken", async ({ expect }) => {
    const { register, session } = await branchWithCounter();
    const colleague = await loadAuthUser(
      (
        await makeUser({
          branchId: register.branchId,
          roleName: "cashier-colleague",
          permissions: ROLE_PERMISSIONS.cashier,
        })
      ).id,
    );
    await openSession({ user: colleague, registerId: register.id, openingCash: "100.00" });

    const response = await session.get("/cash-register-page", HTML);

    expect(response.text).toContain("No register is free");
    expect(response.text).not.toContain(OPEN_FORM);
  });

  test("opening and then closing a register redirects each time and leaves the session CLOSED", async ({
    expect,
  }) => {
    const { register, session } = await branchWithCounter();

    const opened = await session.post("/cash-register/open", {
      ...HTML,
      form: { registerId: register.id, openingCash: "500.00" },
    });
    const whileOpen = await session.get("/cash-register-page", HTML);

    expect([opened.status, opened.location]).toEqual([302, "/cash-register-page"]);
    expect(whileOpen.text).toContain("Register opened");
    expect(whileOpen.text).toContain(CLOSE_FORM);
    expect(whileOpen.text).toContain('name="countedCash"');
    expect(whileOpen.text).toContain("Counter One");
    expect(whileOpen.text).toContain("500.00");
    expect(whileOpen.text).not.toContain(OPEN_FORM);

    const closed = await session.post("/cash-register/close", {
      ...HTML,
      form: { countedCash: "500.00", note: "" },
    });
    const afterwards = await session.get("/cash-register-page", HTML);
    const [row] = await sessions();

    expect([closed.status, closed.location]).toEqual([302, "/cash-register-page"]);
    expect(afterwards.text).toContain("Register closed");
    expect(afterwards.text).toContain(OPEN_FORM);
    expect(row).toMatchObject({ status: "CLOSED", actualCash: "500.00", variance: "0.00" });
  });

  test("the open session shows the cash movements and the expected cash", async ({ expect }) => {
    const world = await makeWorld();
    const session = await loginAs(world.cashier);
    await makeCashTransaction({
      sessionId: world.session.id,
      type: "CASH_SALE",
      amount: "60.00",
      performedBy: world.cashier.id,
    });

    const response = await session.get("/cash-register-page", HTML);

    expect(response.text).toContain("Expected cash");
    expect(response.text).toContain("1,060.00");
    expect(response.text).toContain("Cash sales");
  });

  test("a refused open flashes the reason, shows the form again and creates nothing", async ({
    expect,
  }) => {
    const { register, session } = await branchWithCounter();

    const refused = await session.post("/cash-register/open", {
      ...HTML,
      form: { registerId: register.id, openingCash: "-5" },
    });
    const page = await session.get("/cash-register-page", HTML);

    expect([refused.status, refused.location]).toEqual([302, "/cash-register-page"]);
    expect(page.text).toContain("Opening cash must be zero or more");
    expect(page.text).toContain(OPEN_FORM);
    expect(await sessions()).toHaveLength(0);
  });

  test("a register someone else opened first is refused with a message", async ({ expect }) => {
    const { register, session } = await branchWithCounter();
    const rival = await loadAuthUser(
      (
        await makeUser({
          branchId: register.branchId,
          roleName: "cashier-rival",
          permissions: ROLE_PERMISSIONS.cashier,
        })
      ).id,
    );
    await openSession({ user: rival, registerId: register.id, openingCash: "100.00" });

    await session.post("/cash-register/open", {
      ...HTML,
      form: { registerId: register.id, openingCash: "100.00" },
    });
    const page = await session.get("/cash-register-page", HTML);

    expect(page.text).toContain("That register is not available");
    expect(await sessions()).toHaveLength(1);
  });

  test("a count beyond the threshold without a note keeps the session open and says why", async ({
    expect,
  }) => {
    const { register, session } = await branchWithCounter();
    await session.post("/cash-register/open", {
      ...HTML,
      form: { registerId: register.id, openingCash: "500.00" },
    });

    await session.post("/cash-register/close", {
      ...HTML,
      form: { countedCash: "100.00", note: "" },
    });
    const page = await session.get("/cash-register-page", HTML);

    expect(page.text).toContain("A note is required");
    expect(page.text).toContain(CLOSE_FORM);
    expect((await sessions())[0].status).toBe("OPEN");

    await session.post("/cash-register/close", {
      ...HTML,
      form: { countedCash: "100.00", note: "Cash taken to the safe" },
    });
    const after = await session.get("/cash-register-page", HTML);

    expect((await sessions())[0].status).toBe("RECONCILIATION_REQUIRED");
    expect(after.text).toContain("reconcile");
  });

  test("closing with no open register flashes a message", async ({ expect }) => {
    const { session } = await branchWithCounter();

    const response = await session.post("/cash-register/close", {
      ...HTML,
      form: { countedCash: "100.00" },
    });
    const page = await session.get("/cash-register-page", HTML);

    expect([response.status, response.location]).toEqual([302, "/cash-register-page"]);
    expect(page.text).toContain("You have no open register");
  });

  test("register names are escaped", async ({ expect }) => {
    const { session } = await branchWithCounter({ counterName: XSS });

    const response = await session.get("/cash-register-page", HTML);

    expect(response.text).not.toContain("<img src=x");
    expect(response.text).toContain("&lt;img");
  });

  test("an accountant is denied the page and both actions", async ({ expect }) => {
    const { branch } = await branchWithCounter();
    const accountant = await loginAs(
      await makeUser({
        branchId: branch.id,
        roleName: "accountant-page",
        permissions: ROLE_PERMISSIONS.accountant,
      }),
    );

    expect((await accountant.get("/cash-register-page", HTML)).status).toBe(403);
    expect(
      (await accountant.post("/cash-register/open", { ...HTML, form: { openingCash: "1" } }))
        .status,
    ).toBe(403);
    expect(
      (await accountant.post("/cash-register/close", { ...HTML, form: { countedCash: "1" } }))
        .status,
    ).toBe(403);
  });

  test("a signed-out visitor is sent to the login page", async ({ expect }) => {
    const visitor = new TestSession();

    for (const response of [
      await visitor.get("/cash-register-page", HTML),
      await visitor.post("/cash-register/open", { ...HTML, form: {} }),
      await visitor.post("/cash-register/close", { ...HTML, form: {} }),
    ]) {
      expect([response.status, response.location]).toEqual([302, "/login-page"]);
    }
  });
});

test.group("dashboard register status", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("names the cashier's open register", async ({ expect }) => {
    const world = await makeWorld();
    const session = await loginAs(world.cashier);

    const response = await session.get("/dashboard-page", HTML);

    expect(response.text).toContain(`Register ${world.register.name} open since`);
    expect(response.text).not.toContain("Open a register");
  });

  test("offers to open a register when none is open", async ({ expect }) => {
    const { session } = await branchWithCounter();

    const response = await session.get("/dashboard-page", HTML);

    expect(response.text).toContain("Open a register");
    expect(response.text).toContain('href="/cash-register-page"');
  });
});
