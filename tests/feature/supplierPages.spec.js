import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { suppliers } from "../../app/models/suppliers.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeUser } from "../helpers/factories.js";
import { loginAs } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const XSS = "<img src=x onerror=alert(1)>";

async function setup() {
  const branch = await makeBranch({ code: "MAIN" });
  const person = async (roleName, permissions) => {
    return await loginAs(await makeUser({ roleName, permissions, branchId: branch.id }));
  };
  const supplier = { id: randomUUID(), code: "ACME", name: "Acme Pharma Supply" };

  await db.insert(suppliers).values(supplier);

  return {
    supplier,
    clerk: await person("clerk-suppliers", ROLE_PERMISSIONS.pharmacist),
    accountant: await person("acct-suppliers", ROLE_PERMISSIONS.accountant),
    cashier: await person("cash-suppliers", ROLE_PERMISSIONS.cashier),
  };
}

test.group("supplier pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("viewing needs purchasing.view, changing needs purchasing.manage", async ({ expect }) => {
    const ctx = await setup();

    expect((await ctx.cashier.get("/suppliers", HTML)).status).toBe(403);
    expect((await ctx.accountant.get("/suppliers", HTML)).status).toBe(200);
    expect((await ctx.accountant.get("/suppliers/new", HTML)).status).toBe(403);
    expect((await ctx.accountant.post("/suppliers", { ...HTML, form: {} })).status).toBe(403);
    expect((await ctx.accountant.get(`/suppliers/${ctx.supplier.id}/edit`, HTML)).status).toBe(403);
    expect((await ctx.clerk.get("/suppliers/new", HTML)).status).toBe(200);
  });

  test("a refused new supplier keeps what was typed and escapes it; a valid one is saved", async ({
    expect,
  }) => {
    const ctx = await setup();
    const refused = await ctx.clerk.post("/suppliers", {
      ...HTML,
      form: { code: "", name: XSS, email: "not-an-email", phone: "0917" },
    });

    expect(refused.status).toBe(422);
    expect(refused.text).not.toContain(XSS);
    expect(refused.text).toContain("&lt;img src");
    expect(refused.text).toContain('value="0917"');

    const saved = await ctx.clerk.post("/suppliers", {
      ...HTML,
      form: { code: "NEWCO", name: "New Company" },
    });
    const [row] = await db.select().from(suppliers).where(eq(suppliers.code, "NEWCO"));

    expect(saved.status).toBe(302);
    expect(row.name).toBe("New Company");
  });

  test("editing shows the saved details; a refused edit keeps the typing; a valid edit saves", async ({
    expect,
  }) => {
    const ctx = await setup();
    const path = `/suppliers/${ctx.supplier.id}`;
    const edit = await ctx.clerk.get(`${path}/edit`, HTML);
    const refused = await ctx.clerk.post(path, {
      ...HTML,
      form: { code: "ACME", name: "", contactName: "Rita Cruz" },
    });
    const saved = await ctx.clerk.post(path, {
      ...HTML,
      form: { code: "ACME", name: "Acme Renamed", isActive: "on" },
    });
    const [row] = await db.select().from(suppliers).where(eq(suppliers.id, ctx.supplier.id));

    expect(edit.status).toBe(200);
    expect(edit.text).toContain("Acme Pharma Supply");
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Rita Cruz");
    expect(saved.status).toBe(302);
    expect(row.name).toBe("Acme Renamed");
  });

  test("an unknown or malformed supplier id is a 404, not a 500", async ({ expect }) => {
    const ctx = await setup();

    for (const id of ["not-an-id", randomUUID()]) {
      expect((await ctx.clerk.get(`/suppliers/${id}/edit`, HTML)).status).toBe(404);
      expect(
        (await ctx.clerk.post(`/suppliers/${id}`, { ...HTML, form: { code: "X", name: "Y" } }))
          .status,
      ).toBe(404);
    }
  });
});
