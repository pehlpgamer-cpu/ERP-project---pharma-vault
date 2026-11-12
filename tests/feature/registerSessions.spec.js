import { test } from "@japa/runner";
import { eq } from "drizzle-orm";
import { db } from "../../database/client.js";
import { auditLogs } from "../../app/models/audit-logs.js";
import { cashRegisterSessions } from "../../app/models/cash-register-sessions.js";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { loadAuthUser } from "../../app/services/auth/users.js";
import {
  closeSession,
  getOpenSession,
  listOpenableRegisters,
  openSession,
  sessionSummary,
} from "../../app/services/register/registerSessions.js";
import { resetDatabase } from "../helpers/db.js";
import {
  makeAuthUser,
  makeBranch,
  makeCashTransaction,
  makeOpenSession,
  makeRegister,
  makeSaleIn,
  makeWorld,
} from "../helpers/factories.js";

const NOW = new Date("2026-11-12T01:30:00Z");

function cashier(branch, overrides = {}) {
  return makeAuthUser({
    branchId: branch.id,
    permissions: ROLE_PERMISSIONS.cashier,
    ...overrides,
  });
}

async function sessionRow(id) {
  const [row] = await db.select().from(cashRegisterSessions).where(eq(cashRegisterSessions.id, id));

  return row;
}

async function sessionCount() {
  return (await db.select({ id: cashRegisterSessions.id }).from(cashRegisterSessions)).length;
}

// A world whose open session holds 1000.00 opening cash, 60.00 cash sales, 100.00 cash in,
// 20.00 cash out and 10.00 cash refunds: expected cash is 1130.00.
async function worldWithCash() {
  const world = await makeWorld();
  const user = await loadAuthUser(world.cashier.id);
  const add = (type, amount) => {
    return makeCashTransaction({
      sessionId: world.session.id,
      type,
      amount,
      performedBy: world.cashier.id,
    });
  };

  await add("CASH_SALE", "60.00");
  await add("CASH_IN", "100.00");
  await add("CASH_OUT", "20.00");
  await add("CASH_REFUND", "10.00");

  return { world, user, sessionId: world.session.id };
}

test.group("openSession", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("stores an OPEN session and an audit row, and getOpenSession reads it back", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const register = await makeRegister({ branchId: branch.id, name: "Counter A", code: "A1" });
    const user = await cashier(branch);

    const { id } = await openSession(
      { user, registerId: register.id, openingCash: "1000.00" },
      { now: NOW },
    );

    const row = await sessionRow(id);
    expect(row).toMatchObject({
      status: "OPEN",
      openingCash: "1000.00",
      cashierId: user.id,
      cashRegisterId: register.id,
    });
    expect(row.openedAt.getTime()).toBe(NOW.getTime());
    expect(await getOpenSession(user.id)).toEqual({
      id,
      registerId: register.id,
      registerName: "Counter A",
      registerCode: "A1",
      openingCash: "1000.00",
      openedAt: NOW,
    });

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(audit).toMatchObject({
      action: "REGISTER_OPENED",
      userId: user.id,
      branchId: branch.id,
      entityType: "cash_register_session",
    });
  });

  test("keeps two decimal places for whole amounts and allows a zero float", async ({ expect }) => {
    const branch = await makeBranch();
    const first = await makeRegister({ branchId: branch.id });
    const second = await makeRegister({ branchId: branch.id });

    const whole = await openSession({
      user: await cashier(branch),
      registerId: first.id,
      openingCash: " 250 ",
    });
    const zero = await openSession({
      user: await cashier(branch),
      registerId: second.id,
      openingCash: "0",
    });

    expect((await sessionRow(whole.id)).openingCash).toBe("250.00");
    expect((await sessionRow(zero.id)).openingCash).toBe("0.00");
  });

  test("a second user opening a register that is already open gets 409 register_unavailable", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const register = await makeRegister({ branchId: branch.id });
    const first = await cashier(branch);
    const second = await cashier(branch);
    await openSession({ user: first, registerId: register.id, openingCash: "100.00" });

    await expect(
      openSession({ user: second, registerId: register.id, openingCash: "100.00" }),
    ).rejects.toMatchObject({ status: 409, code: "register_unavailable" });
    expect(await sessionCount()).toBe(1);
  });

  test("a user who already has a register open gets 409 session_exists", async ({ expect }) => {
    const branch = await makeBranch();
    const first = await makeRegister({ branchId: branch.id });
    const second = await makeRegister({ branchId: branch.id });
    const user = await cashier(branch);
    await openSession({ user, registerId: first.id, openingCash: "100.00" });

    await expect(
      openSession({ user, registerId: second.id, openingCash: "100.00" }),
    ).rejects.toMatchObject({ status: 409, code: "session_exists" });
    await expect(
      openSession({ user, registerId: first.id, openingCash: "100.00" }),
    ).rejects.toMatchObject({ status: 409, code: "session_exists" });
    expect(await sessionCount()).toBe(1);
  });

  test("an inactive register, a register of another branch and an unknown register are unavailable", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const other = await makeBranch();
    const inactive = await makeRegister({ branchId: branch.id, isActive: false });
    const elsewhere = await makeRegister({ branchId: other.id });
    const user = await cashier(branch);
    const unknown = "00000000-0000-4000-8000-000000000000";

    for (const registerId of [inactive.id, elsewhere.id, unknown]) {
      await expect(openSession({ user, registerId, openingCash: "100.00" })).rejects.toMatchObject({
        status: 409,
        code: "register_unavailable",
      });
    }

    expect(await sessionCount()).toBe(0);
  });

  test("a user without a branch cannot open any register", async ({ expect }) => {
    const branch = await makeBranch();
    const register = await makeRegister({ branchId: branch.id });
    const admin = await makeAuthUser({ permissions: ROLE_PERMISSIONS.admin });

    await expect(
      openSession({ user: admin, registerId: register.id, openingCash: "100.00" }),
    ).rejects.toMatchObject({ status: 409, code: "register_unavailable" });
  });

  test("rejects a negative, malformed or oversized opening amount with a validation error", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const register = await makeRegister({ branchId: branch.id });
    const user = await cashier(branch);

    for (const openingCash of [
      "-1",
      "-0.01",
      "abc",
      "10.005",
      "1e3",
      "",
      "  ",
      undefined,
      null,
      "1000000000000",
    ]) {
      await expect(
        openSession({ user, registerId: register.id, openingCash }),
      ).rejects.toMatchObject({
        status: 422,
        code: "validation_failed",
      });
    }

    expect(await sessionCount()).toBe(0);
  });

  test("a register id that is not a UUID is a validation error, never a database error", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const user = await cashier(branch);

    for (const registerId of ["not-a-uuid", "é", "", undefined, null]) {
      await expect(openSession({ user, registerId, openingCash: "100.00" })).rejects.toMatchObject({
        status: 422,
        code: "validation_failed",
      });
    }
  });

  test("two simultaneous opens of one register by different users: exactly one succeeds", async ({
    expect,
  }) => {
    const branch = await makeBranch();

    for (let round = 0; round < 5; round += 1) {
      const register = await makeRegister({ branchId: branch.id });
      const first = await cashier(branch);
      const second = await cashier(branch);

      const results = await Promise.allSettled([
        openSession({ user: first, registerId: register.id, openingCash: "100.00" }),
        openSession({ user: second, registerId: register.id, openingCash: "100.00" }),
      ]);
      const rejected = results.filter((result) => {
        return result.status === "rejected";
      });

      expect(
        results.filter((result) => {
          return result.status === "fulfilled";
        }),
      ).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409, code: "register_unavailable" });
    }
  });

  test("two simultaneous opens by one user on different registers: exactly one succeeds", async ({
    expect,
  }) => {
    const branch = await makeBranch();

    for (let round = 0; round < 5; round += 1) {
      const first = await makeRegister({ branchId: branch.id });
      const second = await makeRegister({ branchId: branch.id });
      const user = await cashier(branch);

      const results = await Promise.allSettled([
        openSession({ user, registerId: first.id, openingCash: "100.00" }),
        openSession({ user, registerId: second.id, openingCash: "100.00" }),
      ]);
      const rejected = results.filter((result) => {
        return result.status === "rejected";
      });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409, code: "session_exists" });
    }
  });
});

test.group("sessionSummary and closeSession", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("expected cash is opening plus cash sales and cash in, minus cash out and refunds", async ({
    expect,
  }) => {
    const { world, sessionId } = await worldWithCash();
    await makeSaleIn(world);
    await makeSaleIn(world);
    await makeSaleIn(world, { status: "VOIDED" });
    await makeSaleIn(world, { status: "PENDING" });

    expect(await sessionSummary(sessionId)).toEqual({
      openingCash: "1000.00",
      cashSales: "60.00",
      cashIn: "100.00",
      cashOut: "20.00",
      cashRefunds: "10.00",
      expectedCash: "1130.00",
      salesCount: 2,
    });
  });

  test("a session with no cash movements expects exactly its opening cash", async ({ expect }) => {
    const world = await makeWorld();

    expect(await sessionSummary(world.session.id)).toMatchObject({
      cashSales: "0.00",
      cashIn: "0.00",
      cashOut: "0.00",
      cashRefunds: "0.00",
      expectedCash: "1000.00",
      salesCount: 0,
    });
    expect(await sessionSummary("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("closing with the expected count stores the figures and ends the session", async ({
    expect,
  }) => {
    const { user, sessionId } = await worldWithCash();

    const result = await closeSession({ user, sessionId, countedCash: "1130.00" }, { now: NOW });

    expect(result).toEqual({
      status: "CLOSED",
      expectedCash: "1130.00",
      actualCash: "1130.00",
      variance: "0.00",
    });
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({
      status: "CLOSED",
      expectedCash: "1130.00",
      actualCash: "1130.00",
      variance: "0.00",
    });
    expect(row.closedAt.getTime()).toBe(NOW.getTime());
    expect(await getOpenSession(user.id)).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, sessionId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "REGISTER_CLOSED", userId: user.id });
  });

  test("a shortage of exactly the threshold closes without a note", async ({ expect }) => {
    const { user, sessionId } = await worldWithCash();

    const result = await closeSession({ user, sessionId, countedCash: "1080.00" });

    expect(result).toMatchObject({ status: "CLOSED", variance: "-50.00" });
  });

  test("one cent beyond the threshold needs a note and then needs reconciliation", async ({
    expect,
  }) => {
    const { user, sessionId } = await worldWithCash();

    for (const note of [undefined, "", "   "]) {
      await expect(
        closeSession({ user, sessionId, countedCash: "1079.99", note }),
      ).rejects.toMatchObject({ status: 422, code: "note_required" });
    }

    expect((await sessionRow(sessionId)).status).toBe("OPEN");

    const result = await closeSession(
      { user, sessionId, countedCash: "1079.99", note: "  Drawer short after the lunch rush  " },
      { now: NOW },
    );

    expect(result).toEqual({
      status: "RECONCILIATION_REQUIRED",
      expectedCash: "1130.00",
      actualCash: "1079.99",
      variance: "-50.01",
    });
    expect(await sessionRow(sessionId)).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      variance: "-50.01",
    });

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, sessionId));
    expect(audit.reason).toBe("Drawer short after the lunch rush");
    expect(audit.newValues).toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      variance: "-50.01",
    });
  });

  test("an overage beyond the threshold needs a note too", async ({ expect }) => {
    const { user, sessionId } = await worldWithCash();

    await expect(closeSession({ user, sessionId, countedCash: "1180.01" })).rejects.toMatchObject({
      status: 422,
      code: "note_required",
    });

    const result = await closeSession({ user, sessionId, countedCash: "1180.00" });

    expect(result).toMatchObject({ status: "CLOSED", variance: "50.00" });
  });

  test("REGISTER_VARIANCE_THRESHOLD sets the limit", async ({ expect }) => {
    const { user, sessionId } = await worldWithCash();
    const original = process.env.REGISTER_VARIANCE_THRESHOLD;
    process.env.REGISTER_VARIANCE_THRESHOLD = "10.00";

    try {
      await expect(closeSession({ user, sessionId, countedCash: "1119.99" })).rejects.toMatchObject(
        { code: "note_required" },
      );
      expect(await closeSession({ user, sessionId, countedCash: "1120.00" })).toMatchObject({
        status: "CLOSED",
        variance: "-10.00",
      });
    } finally {
      if (original === undefined) {
        delete process.env.REGISTER_VARIANCE_THRESHOLD;
      } else {
        process.env.REGISTER_VARIANCE_THRESHOLD = original;
      }
    }
  });

  test("another user cannot close the session", async ({ expect }) => {
    const { world, sessionId } = await worldWithCash();
    const stranger = await cashier(world.branch);

    await expect(
      closeSession({ user: stranger, sessionId, countedCash: "1130.00" }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect((await sessionRow(sessionId)).status).toBe("OPEN");
  });

  test("closing a closed session is 409 register_closed and changes nothing", async ({
    expect,
  }) => {
    const { user, sessionId } = await worldWithCash();
    await closeSession({ user, sessionId, countedCash: "1130.00" }, { now: NOW });

    await expect(closeSession({ user, sessionId, countedCash: "5.00" })).rejects.toMatchObject({
      status: 409,
      code: "register_closed",
    });
    expect(await sessionRow(sessionId)).toMatchObject({ actualCash: "1130.00", status: "CLOSED" });
  });

  test("a session waiting for reconciliation cannot be closed again", async ({ expect }) => {
    const { user, sessionId } = await worldWithCash();
    await closeSession({ user, sessionId, countedCash: "900.00", note: "Counted twice" });

    await expect(closeSession({ user, sessionId, countedCash: "1130.00" })).rejects.toMatchObject({
      status: 409,
      code: "register_closed",
    });
  });

  test("a negative, malformed or oversized count, or a very long note, is a validation error", async ({
    expect,
  }) => {
    const { user, sessionId } = await worldWithCash();

    for (const countedCash of ["-1", "abc", "1e3", "", "10.005", undefined, null]) {
      await expect(closeSession({ user, sessionId, countedCash })).rejects.toMatchObject({
        status: 422,
        code: "validation_failed",
      });
    }

    await expect(
      closeSession({ user, sessionId, countedCash: "1130.00", note: "x".repeat(501) }),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect((await sessionRow(sessionId)).status).toBe("OPEN");
  });

  test("an unknown or malformed session id is 404", async ({ expect }) => {
    const branch = await makeBranch();
    const user = await cashier(branch);

    for (const sessionId of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", "é"]) {
      await expect(closeSession({ user, sessionId, countedCash: "100.00" })).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    }
  });
});

test.group("listOpenableRegisters and getOpenSession", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("lists the branch's active registers without an open session, by name", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const other = await makeBranch();
    const taken = await makeRegister({ branchId: branch.id, name: "A taken" });
    const free = await makeRegister({ branchId: branch.id, name: "C free", code: "C1" });
    const reused = await makeRegister({ branchId: branch.id, name: "B reused", code: "B1" });
    await makeRegister({ branchId: branch.id, name: "D inactive", isActive: false });
    await makeRegister({ branchId: other.id, name: "E elsewhere" });
    const holder = await cashier(branch);
    const earlier = await cashier(branch);
    await makeOpenSession({ registerId: taken.id, cashierId: holder.id });
    await makeOpenSession({ registerId: reused.id, cashierId: earlier.id, status: "CLOSED" });

    expect(await listOpenableRegisters(branch.id)).toEqual([
      { id: reused.id, name: "B reused", registerCode: "B1" },
      { id: free.id, name: "C free", registerCode: "C1" },
    ]);
    expect(await listOpenableRegisters(null)).toEqual([]);
  });

  test("getOpenSession is null when the user has no open session or only closed ones", async ({
    expect,
  }) => {
    const branch = await makeBranch();
    const register = await makeRegister({ branchId: branch.id });
    const user = await cashier(branch);

    expect(await getOpenSession(user.id)).toBeNull();

    await makeOpenSession({ registerId: register.id, cashierId: user.id, status: "CLOSED" });
    await makeOpenSession({
      registerId: register.id,
      cashierId: user.id,
      status: "RECONCILIATION_REQUIRED",
    });

    expect(await getOpenSession(user.id)).toBeNull();
  });
});
