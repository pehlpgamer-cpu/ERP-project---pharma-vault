// Cash register sessions: a cashier opens a register with a counted float, sells, then closes it with
// a counted drawer. Cash is reconciled against the ledger in cash_transactions.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import * as z from "zod";
import { db } from "../../../database/client.js";
import { HttpError } from "../../http/errors.js";
import { parse } from "../../http/requests/validate.js";
import { cashRegisterSessions } from "../../models/cash-register-sessions.js";
import { cashRegisters } from "../../models/cash-registers.js";
import { cashTransactions } from "../../models/cash-transactions.js";
import { sales } from "../../models/sales.js";
import { users } from "../../models/users.js";
import { recordAudit } from "../audit/auditLog.js";
import { add, cmp, sub, toScale } from "../support/decimal.js";
import { isUuid } from "../support/ids.js";
import { varianceThreshold } from "../support/settings.js";

const MONEY_SCALE = 2;
// Sales that count toward "sales made in this session": money changed hands and was not voided.
const COUNTED_SALE_STATUSES = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"];

// DECIMAL(14,2): at most 12 whole digits.
const amount = (label) => {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, `${label} must be zero or more, for example 1000.00`);
};

const OpenInput = z.object({
  registerId: z.uuid({ error: "Choose a register" }),
  openingCash: amount("Opening cash"),
});

const CloseInput = z.object({
  countedCash: amount("Counted cash"),
  note: z
    .string({ error: "The note must be text" })
    .trim()
    .max(500, "The note must be 500 characters or fewer")
    .default(""),
});

const registerUnavailable = () => {
  return new HttpError(409, "register_unavailable", "That register is not available");
};

/** The user's open session with its register, or null. */
export async function getOpenSession(userId) {
  const [row] = await db
    .select({
      id: cashRegisterSessions.id,
      registerId: cashRegisters.id,
      registerName: cashRegisters.name,
      registerCode: cashRegisters.registerCode,
      openingCash: cashRegisterSessions.openingCash,
      openedAt: cashRegisterSessions.openedAt,
    })
    .from(cashRegisterSessions)
    .innerJoin(cashRegisters, eq(cashRegisters.id, cashRegisterSessions.cashRegisterId))
    .where(and(eq(cashRegisterSessions.cashierId, userId), eq(cashRegisterSessions.status, "OPEN")))
    .orderBy(desc(cashRegisterSessions.openedAt))
    .limit(1);

  return row ?? null;
}

/** Active registers of the branch that nobody has open, by name. */
export async function listOpenableRegisters(branchId) {
  if (!branchId) {
    return [];
  }

  return db
    .select({
      id: cashRegisters.id,
      name: cashRegisters.name,
      registerCode: cashRegisters.registerCode,
    })
    .from(cashRegisters)
    .where(
      and(
        eq(cashRegisters.branchId, branchId),
        eq(cashRegisters.isActive, true),
        notExists(
          db
            .select({ one: sql`1` })
            .from(cashRegisterSessions)
            .where(
              and(
                eq(cashRegisterSessions.cashRegisterId, cashRegisters.id),
                eq(cashRegisterSessions.status, "OPEN"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(cashRegisters.name), asc(cashRegisters.registerCode));
}

// The session's cash movements, read through `executor` (db, or the closing transaction).
async function buildSummary(executor, sessionId, openingCash) {
  const totals = await executor
    .select({
      type: cashTransactions.transactionType,
      total: sql`SUM(${cashTransactions.amount})`.mapWith(String),
    })
    .from(cashTransactions)
    .where(eq(cashTransactions.cashRegisterSessionId, sessionId))
    .groupBy(cashTransactions.transactionType);
  const byType = Object.fromEntries(
    totals.map(({ type, total }) => {
      return [type, toScale(total, MONEY_SCALE)];
    }),
  );
  const [{ count }] = await executor
    .select({ count: sql`COUNT(*)`.mapWith(Number) })
    .from(sales)
    .where(
      and(eq(sales.cashRegisterSessionId, sessionId), inArray(sales.status, COUNTED_SALE_STATUSES)),
    );
  const zero = toScale("0", MONEY_SCALE);
  const opening = toScale(openingCash, MONEY_SCALE);
  const cashSales = byType.CASH_SALE ?? zero;
  const cashIn = byType.CASH_IN ?? zero;
  const cashOut = byType.CASH_OUT ?? zero;
  const cashRefunds = byType.CASH_REFUND ?? zero;

  return {
    openingCash: opening,
    cashSales,
    cashIn,
    cashOut,
    cashRefunds,
    expectedCash: sub(sub(add(add(opening, cashSales), cashIn), cashOut), cashRefunds),
    salesCount: count,
  };
}

/** Cash figures for a session, or null when there is no such session. */
export async function sessionSummary(sessionId) {
  if (!isUuid(sessionId)) {
    return null;
  }

  const [session] = await db
    .select({ openingCash: cashRegisterSessions.openingCash })
    .from(cashRegisterSessions)
    .where(eq(cashRegisterSessions.id, sessionId));

  return session ? buildSummary(db, sessionId, session.openingCash) : null;
}

/**
 * Opens a register for the user. Concurrent opens queue on the user row and then the register row, so
 * a register has one open session and a user has one open session.
 */
export async function openSession(
  { user, registerId, openingCash, meta = {} },
  { now = new Date() } = {},
) {
  const input = parse(OpenInput, { registerId, openingCash });
  const cash = toScale(input.openingCash, MONEY_SCALE);
  const id = randomUUID();

  await db.transaction(
    async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
      const [register] = await tx
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.id, input.registerId))
        .for("update");
      const [own] = await tx
        .select({ id: cashRegisterSessions.id })
        .from(cashRegisterSessions)
        .where(
          and(eq(cashRegisterSessions.cashierId, user.id), eq(cashRegisterSessions.status, "OPEN")),
        )
        .limit(1);

      if (own) {
        throw new HttpError(409, "session_exists", "You already have a register open");
      }

      if (!register || !register.isActive || register.branchId !== user.branchId) {
        throw registerUnavailable();
      }

      const [taken] = await tx
        .select({ id: cashRegisterSessions.id })
        .from(cashRegisterSessions)
        .where(
          and(
            eq(cashRegisterSessions.cashRegisterId, register.id),
            eq(cashRegisterSessions.status, "OPEN"),
          ),
        )
        .limit(1);

      if (taken) {
        throw registerUnavailable();
      }

      await tx.insert(cashRegisterSessions).values({
        id,
        cashRegisterId: register.id,
        cashierId: user.id,
        openingCash: cash,
        openedAt: now,
        status: "OPEN",
      });
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "REGISTER_OPENED",
        entityType: "cash_register_session",
        entityId: id,
        newValues: {
          registerId: register.id,
          registerCode: register.registerCode,
          openingCash: cash,
        },
        ...meta,
      });
    },
    { isolationLevel: "read committed" },
  );

  return { id };
}

/**
 * Closes the user's own open session against a counted drawer. A count more than the threshold away
 * from the expected cash needs a note and leaves the session waiting for reconciliation.
 */
export async function closeSession(
  { user, sessionId, countedCash, note, meta = {} },
  { now = new Date() } = {},
) {
  const input = parse(CloseInput, { countedCash, note });

  if (!isUuid(sessionId)) {
    throw new HttpError(404, "not_found", "Register session not found");
  }

  return db.transaction(
    async (tx) => {
      const [session] = await tx
        .select()
        .from(cashRegisterSessions)
        .where(eq(cashRegisterSessions.id, sessionId))
        .for("update");

      if (!session) {
        throw new HttpError(404, "not_found", "Register session not found");
      }

      if (session.cashierId !== user.id) {
        throw new HttpError(
          403,
          "forbidden",
          "Only the cashier who opened a register can close it",
        );
      }

      if (session.status !== "OPEN") {
        throw new HttpError(409, "register_closed", "This register session is already closed");
      }

      const { expectedCash } = await buildSummary(tx, session.id, session.openingCash);
      const counted = toScale(input.countedCash, MONEY_SCALE);
      const variance = sub(counted, expectedCash);
      const threshold = varianceThreshold();
      const beyondThreshold =
        cmp(variance, threshold) > 0 || cmp(variance, sub("0", threshold)) < 0;

      if (beyondThreshold && input.note === "") {
        const message = `A note is required when the count is more than ${threshold} over or under the expected cash`;

        throw new HttpError(422, "note_required", message, [{ path: "note", message }]);
      }

      const status = beyondThreshold ? "RECONCILIATION_REQUIRED" : "CLOSED";

      await tx
        .update(cashRegisterSessions)
        .set({ expectedCash, actualCash: counted, variance, closedAt: now, status })
        .where(eq(cashRegisterSessions.id, session.id));
      await recordAudit(tx, {
        userId: user.id,
        branchId: user.branchId,
        action: "REGISTER_CLOSED",
        entityType: "cash_register_session",
        entityId: session.id,
        oldValues: { status: "OPEN" },
        newValues: { status, expectedCash, actualCash: counted, variance },
        reason: input.note === "" ? null : input.note,
        ...meta,
      });

      return { status, expectedCash, actualCash: counted, variance };
    },
    { isolationLevel: "read committed" },
  );
}
