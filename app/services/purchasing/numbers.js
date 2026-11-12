import { eq, sql } from "drizzle-orm";
import { documentSequences } from "../../models/document-sequences.js";

/**
 * The next gap-free document number for a branch and business day, for example
 * `PO-MAIN-20261112-0001`. Call it inside the transaction that uses the number: a rollback undoes
 * the increment. `today` is a YYYY-MM-DD business date.
 */
export async function nextDocumentNumber(tx, prefix, branchCode, today) {
  const day = today.replaceAll("-", "");
  const scope = `${prefix}:${branchCode}:${day}`;

  await tx
    .insert(documentSequences)
    .values({ scope, lastValue: 1 })
    .onDuplicateKeyUpdate({ set: { lastValue: sql`${documentSequences.lastValue} + 1` } });

  const [counter] = await tx
    .select({ lastValue: documentSequences.lastValue })
    .from(documentSequences)
    .where(eq(documentSequences.scope, scope));

  return `${prefix}-${branchCode}-${day}-${String(counter.lastValue).padStart(4, "0")}`;
}
