import { auditLogs } from "../../models/audit-logs.js";

/**
 * Appends one row to the audit trail. `executor` is `db` or a transaction, so a business change and
 * its audit row commit or roll back together. Never pass passwords or other secrets in the values.
 */
export async function recordAudit(
  executor,
  {
    userId = null,
    branchId = null,
    action,
    entityType,
    entityId = null,
    oldValues = null,
    newValues = null,
    reason = null,
    ipAddress = null,
    userAgent = null,
  },
) {
  await executor.insert(auditLogs).values({
    userId,
    branchId,
    action,
    entityType,
    entityId,
    oldValues,
    newValues,
    reason,
    ipAddress,
    userAgent,
  });
}
