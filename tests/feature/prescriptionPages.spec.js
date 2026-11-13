import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { prescriptions } from "../../app/models/prescriptions.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeBranch,
  makeOpenSession,
  makeProduct,
  makeRegister,
  makeUser,
} from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };
const JSON_ACCEPT = { headers: { accept: "application/json" } };
const XSS = "<img src=x onerror=alert(1)>";

async function setup() {
  const branch = await makeBranch({ code: "MAIN" });
  const person = async (roleName, permissions) => {
    return await makeUser({ roleName, permissions, branchId: branch.id });
  };
  const cashierUser = await person("cashier-rx", ROLE_PERMISSIONS.cashier);
  const register = await makeRegister({ branchId: branch.id });
  const rx = await makeProduct({
    branchId: branch.id,
    name: "Amoxicillin 500 mg Capsule",
    classification: "PRESCRIPTION",
    requiresPrescription: true,
    units: [{ name: "Capsule", factor: "1", base: true, price: "12.0000" }],
    batches: [{ quantity: "1000", batchNumber: "AMOX-1" }],
  });

  await makeOpenSession({ registerId: register.id, cashierId: cashierUser.id });

  return {
    rx,
    cashier: await loginAs(cashierUser),
    pharmacist: await loginAs(await person("pharmacist-rx", ROLE_PERMISSIONS.pharmacist)),
    accountant: await loginAs(await person("accountant-rx", ROLE_PERMISSIONS.accountant)),
  };
}

const form = (ctx, overrides = {}) => {
  return {
    physicianName: "Dr. Maria Santos",
    licenseNumber: "PRC-12345",
    prescriptionDate: "2026-11-01",
    validUntil: "2030-01-01",
    "items[0][sku]": ctx.rx.product.sku,
    "items[0][prescribedQuantity]": "30",
    "items[0][dosageInstructions]": "1 capsule three times a day",
    ...overrides,
  };
};

const recordIn = async (ctx) => {
  const saved = await ctx.cashier.post("/prescriptions", { ...HTML, form: form(ctx) });

  return saved.location.split("/").pop();
};

test.group("prescription pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("recording needs prescriptions.manage, verifying needs prescriptions.verify", async ({
    expect,
  }) => {
    const ctx = await setup();
    const id = await recordIn(ctx);

    for (const path of ["/prescriptions", `/prescriptions/${id}`]) {
      expect([path, (await ctx.accountant.get(path, HTML)).status]).toEqual([path, 403]);
      expect([path, (await ctx.cashier.get(path, HTML)).status]).toEqual([path, 200]);
      expect([path, (await ctx.pharmacist.get(path, HTML)).status]).toEqual([path, 200]);
      expect((await new TestSession().get(path, HTML)).location).toBe("/login-page");
    }

    expect((await ctx.accountant.get("/prescriptions/new", HTML)).status).toBe(403);
    expect((await ctx.cashier.post(`/prescriptions/${id}/verify`, HTML)).status).toBe(403);
    expect((await ctx.cashier.post(`/prescriptions/${id}/reject`, HTML)).status).toBe(403);
    expect((await ctx.cashier.get("/prescriptions/not-an-id", HTML)).status).toBe(404);
  });

  test("a refused form keeps what was typed and escapes it; a saved one shows its items", async ({
    expect,
  }) => {
    const ctx = await setup();
    const refused = await ctx.cashier.post("/prescriptions", {
      ...HTML,
      form: form(ctx, { physicianName: XSS, "items[0][prescribedQuantity]": "0" }),
    });
    const id = await recordIn(ctx);
    const page = await ctx.cashier.get(`/prescriptions/${id}`, HTML);
    const list = await ctx.cashier.get("/prescriptions?q=0001", HTML);

    expect(refused.status).toBe(422);
    expect(refused.text).toContain("Enter the prescribed quantity");
    expect(refused.text).not.toContain(XSS);
    expect(refused.text).toContain("&lt;img src");
    expect(page.text).toContain("Amoxicillin 500 mg Capsule");
    expect(page.text).toContain("Pending verification");
    expect(page.text).not.toContain("/verify");
    expect(list.text).toContain("RX-MAIN-");
    expect((await ctx.cashier.get("/prescriptions?page=99999999999999999999", HTML)).status).toBe(
      200,
    );
  });

  test("a license under another name is flagged on the license field", async ({ expect }) => {
    const ctx = await setup();

    await recordIn(ctx);

    const clash = await ctx.cashier.post("/prescriptions", {
      ...HTML,
      form: form(ctx, { physicianName: "Dr. Someone Else" }),
    });

    expect(clash.status).toBe(422);
    expect(clash.text).toContain("belongs to Dr. Maria Santos");
  });

  test("a pharmacist verifies, and the POS lookup then finds it", async ({ expect }) => {
    const ctx = await setup();
    const id = await recordIn(ctx);
    const [{ prescriptionNumber }] = await db.select().from(prescriptions);
    const lookup = (session, number) => {
      return session.get(
        `/api/v1/prescriptions/lookup?number=${encodeURIComponent(number)}`,
        JSON_ACCEPT,
      );
    };

    expect((await lookup(ctx.cashier, prescriptionNumber)).status).toBe(409);

    const pending = await ctx.pharmacist.get(`/prescriptions/${id}`, HTML);

    expect(pending.text).toContain("/verify");

    await ctx.pharmacist.post(`/prescriptions/${id}/verify`, HTML);

    const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, id));
    const found = await lookup(ctx.cashier, prescriptionNumber);

    expect(row.status).toBe("VERIFIED");
    expect(found.status).toBe(200);
    expect(found.json().data.items[0]).toMatchObject({
      productName: "Amoxicillin 500 mg Capsule",
      remaining: "30.000",
    });
    expect((await lookup(ctx.cashier, "RX-NOPE")).status).toBe(404);
    expect((await lookup(ctx.cashier, "")).status).toBe(422);
    expect((await lookup(ctx.accountant, prescriptionNumber)).status).toBe(403);
    expect((await ctx.cashier.get(`/prescriptions/${id}`, HTML)).text).toContain("Verified");
  });

  test("a rejection needs a reason and is flashed back, not a 500", async ({ expect }) => {
    const ctx = await setup();
    const id = await recordIn(ctx);
    const empty = await ctx.pharmacist.post(`/prescriptions/${id}/reject`, { ...HTML, form: {} });
    const [still] = await db.select().from(prescriptions).where(eq(prescriptions.id, id));

    expect(empty.status).toBe(302);
    expect(still.status).toBe("PENDING_VERIFICATION");

    await ctx.pharmacist.post(`/prescriptions/${id}/reject`, {
      ...HTML,
      form: { reason: "Quantity altered" },
    });
    await ctx.pharmacist.post(`/prescriptions/${id}/verify`, HTML);

    const page = await ctx.pharmacist.get(`/prescriptions/${id}`, HTML);

    expect(page.text).toContain("Rejected");
    expect(page.text).toContain("cannot be verified");
  });

  test("the sales screen has the prescription box", async ({ expect }) => {
    const ctx = await setup();
    const page = await ctx.cashier.get("/pos-page", HTML);

    expect(page.text).toContain('id="pos-rx-number"');
    expect(page.text).toContain("/api/v1/prescriptions/lookup");
  });
});
