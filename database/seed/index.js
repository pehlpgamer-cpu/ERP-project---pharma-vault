import { pathToFileURL } from "node:url";
import { count } from "drizzle-orm";
import { branches } from "../../app/models/branches.js";
import { closeDb, db } from "../client.js";
import { seedBase } from "./base.js";

const DEFAULT_PASSWORD = "PharmaVault-demo-2026";

/**
 * Seeds an empty development database with demo data. Refuses to run in production or on a
 * database that already has branches.
 */
export async function runSeed({ log = console.log } = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database");
  }

  const password = process.env.SEED_PASSWORD || DEFAULT_PASSWORD;

  if (password.length < 14) {
    throw new Error("SEED_PASSWORD must be at least 14 characters");
  }

  const [{ total }] = await db.select({ total: count() }).from(branches);

  if (Number(total) > 0) {
    throw new Error("Database already seeded");
  }

  const refs = await seedBase(db, { password });

  log("Seeded demo data. Sign in with any of these accounts:");

  for (const user of Object.values(refs.users)) {
    log(`  ${user.email}  (${user.role})`);
  }

  log(`Password for every account: ${password}`);
}

// `node database/seed/index.js` (npm run db:seed) runs the seed; importing this file does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSeed();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
