// Read side of the audit trail: the investigation view over audit_logs. Admin only. Old and new
// values are redacted before they leave this module, so a secret that ever reached the log is not
// shown. The log itself is append-only by policy and nothing here writes to it.

import { and, asc, count, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { db } from "../../../database/client.js";
import { HttpError } from "../../http/errors.js";
import { auditLogs } from "../../models/audit-logs.js";
import { branches } from "../../models/branches.js";
import { users } from "../../models/users.js";
import { can, PERMISSIONS } from "../auth/permissions.js";
import { entityLink } from "../support/entityLinks.js";
import { isUuid } from "../support/ids.js";
import { isRealDay, startOfBusinessDay, startOfNextBusinessDay } from "../support/time.js";

const PAGE_SIZE = 50;
const SECRET_KEY = /password|secret|token|card|^pin$/i;

/** A copy of `value` with every secret-looking key (at any depth) replaced by "[redacted]". */
export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        return [key, SECRET_KEY.test(key) ? "[redacted]" : redact(inner)];
      }),
    );
  }

  return value;
}

const escapeLike = (value) => {
  return value.replace(/[\\%_]/g, (character) => {
    return `\\${character}`;
  });
};

const pretty = (value) => {
  return value === null || value === undefined ? null : JSON.stringify(redact(value), null, 2);
};

/**
 * Audit events newest first. Filters: from, to (business dates, ignored when not real dates), action
 * (starts with), entityType, entityId (a UUID), q (user name or email contains), page.
 * Throws 403 without audit.view.
 */
export async function listAuditEvents(user, filters = {}) {
  if (!can(user, PERMISSIONS.AUDIT_VIEW)) {
    throw new HttpError(403, "forbidden", "You do not have access to the audit trail");
  }

  const conditions = [];

  if (isRealDay(filters.from)) {
    conditions.push(gte(auditLogs.createdAt, startOfBusinessDay(filters.from)));
  }

  if (isRealDay(filters.to)) {
    conditions.push(lt(auditLogs.createdAt, startOfNextBusinessDay(filters.to)));
  }

  if (typeof filters.action === "string" && filters.action.trim() !== "") {
    conditions.push(like(auditLogs.action, `${escapeLike(filters.action.trim())}%`));
  }

  if (typeof filters.entityType === "string" && filters.entityType !== "") {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }

  if (typeof filters.entityId === "string" && filters.entityId.trim() !== "") {
    const id = filters.entityId.trim();

    conditions.push(isUuid(id) ? eq(auditLogs.entityId, id) : sql`1 = 0`);
  }

  if (typeof filters.q === "string" && filters.q.trim() !== "") {
    const needle = `%${escapeLike(filters.q.trim())}%`;

    conditions.push(or(like(users.name, needle), like(users.email, needle)));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const page =
    Number.isSafeInteger(filters.page) && filters.page > 0 ? Math.min(filters.page, 100000) : 1;
  const [{ n }] = await db
    .select({ n: count() })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(where);
  const rows = await db
    .select({
      id: auditLogs.id,
      createdAt: auditLogs.createdAt,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      reason: auditLogs.reason,
      oldValues: auditLogs.oldValues,
      newValues: auditLogs.newValues,
      ipAddress: auditLogs.ipAddress,
      userName: users.name,
      branchName: branches.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .leftJoin(branches, eq(branches.id, auditLogs.branchId))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const types = await db
    .selectDistinct({ entityType: auditLogs.entityType })
    .from(auditLogs)
    .orderBy(asc(auditLogs.entityType));

  return {
    rows: rows.map(({ oldValues, newValues, ...row }) => {
      return {
        ...row,
        link: entityLink(row.entityType, row.entityId),
        oldJson: pretty(oldValues),
        newJson: pretty(newValues),
      };
    }),
    total: n,
    page,
    pageSize: PAGE_SIZE,
    entityTypes: types.map((row) => {
      return row.entityType;
    }),
  };
}
