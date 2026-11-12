import { test } from "@japa/runner";
import { count, eq, sql } from "drizzle-orm";
import { db } from "../../database/client.js";
import { seedBase } from "../../database/seed/base.js";
import { runSeed } from "../../database/seed/index.js";
import { branches } from "../../app/models/branches.js";
import { cashRegisters } from "../../app/models/cash-registers.js";
import { customers } from "../../app/models/customers.js";
import { permissions } from "../../app/models/permissions.js";
import { productUnits } from "../../app/models/product-units.js";
import { products } from "../../app/models/products.js";
import { roles } from "../../app/models/roles.js";
import { units } from "../../app/models/units.js";
import { users } from "../../app/models/users.js";
import { verifyPassword } from "../../app/services/auth/passwords.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import { resetDatabase } from "../helpers/db.js";

const PASSWORD = "seed-password-14";
const NOW = new Date("2026-11-12T03:00:00Z");

async function scalar(query) {
  const [rows] = await db.execute(query);

  return Number(rows[0].n);
}

test.group("base seed", (group) => {
  let refs;

  group.setup(async () => {
    await resetDatabase();
    refs = await seedBase(db, { password: PASSWORD, now: NOW });
  });

  group.teardown(async () => {
    await resetDatabase();
  });

  test("creates the two branches, four roles, fourteen permissions and five users", async ({
    expect,
  }) => {
    const codes = (await db.select().from(branches)).map((branch) => {
      return branch.code;
    });

    expect(codes.sort()).toEqual(["MAIN", "NORTH"]);
    expect((await db.select({ n: count() }).from(roles))[0].n).toBe(4);
    expect((await db.select({ n: count() }).from(permissions))[0].n).toBe(14);
    expect((await loadAuthUser(refs.users.pharmacist.id)).permissions).toContain("products.manage");
    expect((await loadAuthUser(refs.users.admin.id)).permissions).toContain("products.manage");
    expect((await db.select({ n: count() }).from(users))[0].n).toBe(5);
    expect(Object.keys(refs.users).sort()).toEqual([
      "accountant",
      "admin",
      "cashierMain",
      "cashierNorth",
      "pharmacist",
    ]);
  });

  test("every account signs in with the seed password", async ({ expect }) => {
    for (const user of Object.values(refs.users)) {
      const [row] = await db.select().from(users).where(eq(users.id, user.id));

      expect([user.email, await verifyPassword(row.password, PASSWORD)]).toEqual([
        user.email,
        true,
      ]);
      expect(user.email.endsWith("@pharmavault.test")).toBe(true);
    }
  });

  test("the cashier holds exactly the four cashier permissions in MAIN", async ({ expect }) => {
    const cashier = await loadAuthUser(refs.users.cashierMain.id);

    expect(cashier.permissions).toEqual([
      "dashboard.view",
      "register.manage",
      "sales.create",
      "sales.view.own",
    ]);
    expect(cashier.branchCode).toBe("MAIN");
    expect((await loadAuthUser(refs.users.cashierNorth.id)).branchCode).toBe("NORTH");
    expect((await loadAuthUser(refs.users.accountant.id)).permissions).toEqual([
      "dashboard.view",
      "inventory.view",
      "purchasing.view",
      "sales.view.all",
    ]);
  });

  test("the catalog has the paracetamol example and Rx products", async ({ expect }) => {
    const [paracetamol] = await db.select().from(products).where(eq(products.sku, "PARA-500-001"));
    const unitRows = await db
      .select({ name: units.name, factor: productUnits.conversionFactor })
      .from(productUnits)
      .innerJoin(units, eq(units.id, productUnits.unitId))
      .where(eq(productUnits.productId, paracetamol.id));
    const factors = Object.fromEntries(
      unitRows.map((row) => {
        return [row.name, row.factor];
      }),
    );

    expect(paracetamol.productName).toBe("Paracetamol 500 mg Tablet");
    expect(paracetamol.reorderLevel).toBe("200.000");
    expect(paracetamol.prescriptionClassification).toBe("OTC");
    expect(factors).toEqual({ Tablet: "1.000", Strip: "10.000", Box: "100.000" });
    expect(refs.products.length).toBeGreaterThanOrEqual(12);
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM products WHERE prescription_classification = 'PRESCRIPTION' AND requires_prescription = 1`,
      ),
    ).toBeGreaterThanOrEqual(4);
  });

  test("every sellable unit has a global price and one branch override exists", async ({
    expect,
  }) => {
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM product_units pu WHERE pu.can_be_sold = 1 AND NOT EXISTS (SELECT 1 FROM product_prices pp WHERE pp.product_unit_id = pu.id AND pp.branch_id IS NULL AND pp.is_active = 1 AND pp.effective_from <= ${new Date(NOW.getTime() - 59 * 86_400_000)})`,
      ),
    ).toBe(0);
    expect(
      await scalar(sql`SELECT COUNT(*) AS n FROM product_prices WHERE branch_id IS NOT NULL`),
    ).toBeGreaterThanOrEqual(1);
  });

  test("MAIN has an expired, a quarantined and a recalled batch next to normal stock", async ({
    expect,
  }) => {
    const main = refs.branches.main.id;

    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventory_batches WHERE branch_id = ${main} AND status = 'ACTIVE' AND expiration_date < '2026-11-12'`,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventory_batches WHERE branch_id = ${main} AND status = 'QUARANTINED'`,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventory_batches WHERE branch_id = ${main} AND status = 'RECALLED'`,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventory_batches WHERE branch_id = ${main} AND status = 'ACTIVE' AND (expiration_date IS NULL OR expiration_date >= '2026-11-12')`,
      ),
    ).toBeGreaterThanOrEqual(refs.products.length);
  });

  test("each product has two or three batches per branch, received long before today", async ({
    expect,
  }) => {
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventories i WHERE (SELECT COUNT(*) FROM inventory_batches b WHERE b.inventory_id = i.id) NOT BETWEEN 2 AND 3`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventory_batches WHERE received_at > ${new Date(NOW.getTime() - 45 * 86_400_000)}`,
      ),
    ).toBe(0);
    expect(await scalar(sql`SELECT COUNT(*) AS n FROM inventories`)).toBe(2 * refs.products.length);
  });

  test("on-hand quantity equals the sum of the batch quantities", async ({ expect }) => {
    expect(
      await scalar(
        sql`SELECT COUNT(*) AS n FROM inventories i WHERE i.quantity_on_hand <> (SELECT COALESCE(SUM(b.quantity_available), 0) FROM inventory_batches b WHERE b.inventory_id = i.id)`,
      ),
    ).toBe(0);
  });

  test("one register per branch and five customers", async ({ expect }) => {
    const registers = await db.select().from(cashRegisters);

    expect(registers).toHaveLength(2);
    expect(
      registers.map((register) => {
        return register.registerCode;
      }),
    ).toEqual(["R1", "R1"]);
    expect((await db.select({ n: count() }).from(customers))[0].n).toBe(5);
  });

  test("runSeed refuses a database that is already seeded", async ({ expect }) => {
    await expect(runSeed({ log() {} })).rejects.toThrow("Database already seeded");
  });
});

test.group("seed guards", () => {
  test("runSeed refuses to run in production", async ({ expect }) => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      await expect(runSeed({ log() {} })).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test("runSeed rejects a short SEED_PASSWORD", async ({ expect }) => {
    const original = process.env.SEED_PASSWORD;
    process.env.SEED_PASSWORD = "short";
    await resetDatabase();

    try {
      await expect(runSeed({ log() {} })).rejects.toThrow(/14 characters/);
    } finally {
      if (original === undefined) {
        delete process.env.SEED_PASSWORD;
      } else {
        process.env.SEED_PASSWORD = original;
      }
    }
  });
});
