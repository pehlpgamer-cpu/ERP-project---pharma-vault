/** The MySQL error code of a raw mysql2 error or of a Drizzle error wrapping one. */
export function mysqlErrorCode(error) {
  return error?.cause?.code ?? error?.code ?? null;
}

export function isDuplicateEntry(error) {
  return mysqlErrorCode(error) === "ER_DUP_ENTRY";
}

export function isDeadlock(error) {
  return mysqlErrorCode(error) === "ER_LOCK_DEADLOCK";
}
