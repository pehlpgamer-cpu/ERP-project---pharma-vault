// Canary for drizzle-orm 1.0.0-rc.4 + mysql2: each test proves one call form that later tasks rely on.
// Recorded working forms (later tasks must reuse exactly these):
//   Client            database/client.js: callback-style mysql2 pool; db = drizzle({ client, relations, casing })
//   Relational query  db.query.cashRegisters.findFirst({ where: { id }, with: { branch: true } })
//   Locking read      tx.select().from(t).where(...).orderBy(...).for("update")  or  .for("share")
//   Transaction       db.transaction(async (tx) => { ... }, { isolationLevel: "read committed" })
//   Raw SQL           const [rows] = await tx.execute(sql`SELECT ...`)   (also db.execute; [rows, fields])
//   Upsert            db.insert(t).values(v).onDuplicateKeyUpdate({ set: { col: sql`CONCAT(${t.col}, '!')` } })
//   Types             DECIMAL columns are strings; TIMESTAMP defaults are UTC Dates; DATE columns are Dates
//                     at UTC midnight (use toDateString from app/services/support/time.js, Task 4)
//   Isolation         @@transaction_isolation does not show the per-transaction level (the SET applies to
//                     the next transaction only), so isolation is asserted by behavior, as below
//   Ids               tests pass explicit ids (randomUUID) instead of reading generated ones back
import { randomUUID } from "node:crypto";
import { test } from "@japa/runner";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { resetDatabase } from "../../helpers/db.js";
import { auditLogs } from "../../../app/models/audit-logs.js";
import { branches } from "../../../app/models/branches.js";
import { cashRegisters } from "../../../app/models/cash-registers.js";
import { customers } from "../../../app/models/customers.js";
import { products } from "../../../app/models/products.js";

test.group("drizzle canary", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("relational query: object where and nested with", async ({ expect }) => {
    const branchId = randomUUID();
    const registerId = randomUUID();
    await db.insert(branches).values({ id: branchId, name: "Canary", code: "CAN" });
    await db
      .insert(cashRegisters)
      .values({ id: registerId, branchId, name: "Counter 1", registerCode: "R1" });

    const register = await db.query.cashRegisters.findFirst({
      where: { id: registerId },
      with: { branch: true },
    });

    expect(register.branch.code).toBe("CAN");
  });

  test("select for update and for share, raw sql returns [rows, fields]", async ({ expect }) => {
    await db.insert(branches).values({ id: randomUUID(), name: "Canary", code: "CAN" });

    const result = await db.transaction(async (tx) => {
      const forUpdate = await tx
        .select()
        .from(branches)
        .where(eq(branches.code, "CAN"))
        .for("update");
      const forShare = await tx
        .select()
        .from(branches)
        .where(eq(branches.code, "CAN"))
        .for("share");
      const [rows] = await tx.execute(sql`SELECT 1 AS v`);

      return { forUpdate, forShare, raw: rows[0].v };
    });

    expect(result.forUpdate).toHaveLength(1);
    expect(result.forShare).toHaveLength(1);
    expect(result.raw).toBe(1);
  });

  test("isolationLevel read committed sees rows another connection commits mid-transaction", async ({
    expect,
  }) => {
    const seen = await db.transaction(
      async (tx) => {
        const before = await tx.select().from(branches).where(eq(branches.code, "RC"));
        await db.insert(branches).values({ id: randomUUID(), name: "Later", code: "RC" });
        const after = await tx.select().from(branches).where(eq(branches.code, "RC"));

        return { before: before.length, after: after.length };
      },
      { isolationLevel: "read committed" },
    );

    expect(seen).toEqual({ before: 0, after: 1 });
  });

  test("insert on duplicate key update with a raw expression", async ({ expect }) => {
    await db.insert(branches).values({ id: randomUUID(), name: "Canary", code: "CAN" });
    await db
      .insert(branches)
      .values({ id: randomUUID(), name: "Canary", code: "CAN" })
      .onDuplicateKeyUpdate({ set: { name: sql`CONCAT(${branches.name}, '!')` } });

    const rows = await db.select().from(branches).where(eq(branches.code, "CAN"));

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Canary!");
  });

  test("DECIMAL columns are strings", async ({ expect }) => {
    const productId = randomUUID();
    await db
      .insert(products)
      .values({ id: productId, sku: "CAN-1", genericName: "Generic", productName: "Product" });

    const [row] = await db.select().from(products).where(eq(products.id, productId));

    expect(row.reorderLevel).toBe("0.000");
  });

  test("TIMESTAMP defaults are UTC", async ({ expect }) => {
    const id = randomUUID();
    await db.insert(auditLogs).values({ id, action: "CANARY", entityType: "canary" });

    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, id));

    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  test("DATE columns come back as a Date at UTC midnight", async ({ expect }) => {
    const id = randomUUID();
    await db.insert(customers).values({
      id,
      customerNumber: "C-1",
      firstName: "Ana",
      lastName: "Reyes",
      birthDate: new Date("1990-05-17T00:00:00Z"),
    });

    const [row] = await db.select().from(customers).where(eq(customers.id, id));

    expect(row.birthDate).toBeInstanceOf(Date);
    expect(row.birthDate.toISOString().slice(0, 10)).toBe("1990-05-17");
  });
});
