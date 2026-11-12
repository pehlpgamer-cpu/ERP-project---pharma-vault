import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import {
  createSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from "../../app/services/purchasing/suppliers.js";
import { resetDatabase } from "../helpers/db.js";
import { makeBranch, makeUser } from "../helpers/factories.js";

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to fail");
}

async function actor() {
  const branch = await makeBranch();

  return await makeUser({ branchId: branch.id });
}

const SUPPLIER = { code: "ACME", name: "Acme Pharma", email: "orders@acme.test" };

test.group("suppliers", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("create stores the trimmed supplier, makes it active and audits it", async ({ expect }) => {
    const user = await actor();
    const { id } = await createSupplier(user, {
      ...SUPPLIER,
      code: "  ACME ",
      phone: "",
      paymentTerms: "Net 30",
    });
    const supplier = await getSupplier(id);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));

    expect(supplier).toMatchObject({
      code: "ACME",
      name: "Acme Pharma",
      phone: null,
      paymentTerms: "Net 30",
      isActive: true,
    });
    expect(audit.action).toBe("SUPPLIER_CREATED");
    expect(audit.userId).toBe(user.id);
  });

  test("code and name are required, lengths and email are checked, with a message per field", async ({
    expect,
  }) => {
    const user = await actor();
    const error = await failure(
      createSupplier(user, { code: " ", name: "x".repeat(256), email: "nope", phone: 5 }),
    );

    expect([error.status, error.code]).toEqual([422, "validation_failed"]);
    expect(
      error.details.map((detail) => {
        return detail.path;
      }),
    ).toEqual(["code", "name", "phone", "email"]);
  });

  test("a second supplier with the same code is a field error, not a 500", async ({ expect }) => {
    const user = await actor();

    await createSupplier(user, SUPPLIER);

    const error = await failure(createSupplier(user, { ...SUPPLIER, name: "Other" }));

    expect([error.status, error.details[0].path]).toEqual([422, "code"]);
    expect(await listSuppliers()).toHaveLength(1);
  });

  test("update replaces the details, can deactivate, and audits each", async ({ expect }) => {
    const user = await actor();
    const { id } = await createSupplier(user, SUPPLIER);

    await updateSupplier(user, id, { ...SUPPLIER, name: "Acme Ltd", isActive: false });

    expect(await getSupplier(id)).toMatchObject({ name: "Acme Ltd", isActive: false });

    await updateSupplier(user, id, { ...SUPPLIER, isActive: true });

    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, id)))
      .map((row) => {
        return row.action;
      })
      .sort();

    expect((await getSupplier(id)).isActive).toBe(true);
    expect(actions).toEqual(["SUPPLIER_CREATED", "SUPPLIER_DEACTIVATED", "SUPPLIER_UPDATED"]);
  });

  test("unknown and malformed ids are a 404; list filters by text and active", async ({
    expect,
  }) => {
    const user = await actor();
    const { id } = await createSupplier(user, SUPPLIER);
    const other = await createSupplier(user, { code: "ZED", name: "Zed 100%" });

    await updateSupplier(user, other.id, { code: "ZED", name: "Zed 100%", isActive: false });

    const missing = await failure(getSupplier("nope"));
    const missingUpdate = await failure(
      updateSupplier(user, "00000000-0000-4000-8000-000000000000", SUPPLIER),
    );

    expect([missing.status, missingUpdate.status]).toEqual([404, 404]);
    expect(
      (await listSuppliers({ active: true })).map((row) => {
        return row.id;
      }),
    ).toEqual([id]);
    expect(
      (await listSuppliers({ q: "100%" })).map((row) => {
        return row.code;
      }),
    ).toEqual(["ZED"]);
    expect(await listSuppliers({ q: "%" })).toHaveLength(1);
  });
});
