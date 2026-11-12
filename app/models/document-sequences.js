import * as t from "drizzle-orm/mysql-core";

// Gap-free counters, one row per scope (for example "invoice:MAIN:20261112").
// Increment with INSERT ... ON DUPLICATE KEY UPDATE inside the transaction that uses the number.
export const documentSequences = t.mysqlTable("document_sequences", {
  scope: t.varchar("scope", { length: 100 }).primaryKey(),
  lastValue: t.int("last_value", { unsigned: true }).notNull().default(0),
  updatedAt: t.timestamp("updated_at").defaultNow().onUpdateNow(),
});
