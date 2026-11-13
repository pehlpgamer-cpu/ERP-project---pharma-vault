import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const command = args[0] || "start";
const rest = args.slice(1);

// Short aliases for the npm scripts that exist
const aliases = {
  s: "start",
  d: "xian",
  dev: "xian",
  t: "test",
};

if (command === "--help" || command === "-h" || command === "help") {
  console.log(`
Pharma Vault CLI

Usage:
  xian [command] [args]

Commands:
  xian                  Start the server (alias: xian start)
  xian dev              Start with nodemon (hot reload)
  xian test             Run the test suite
  xian route:list       List all registered routes
  xian views:check      Check that every page, partial and helper resolves
  xian db:seed          Load demo data into an empty development database
  xian db:bootstrap     Create roles, permissions, a branch and the first admin (production-safe)
  xian db:schema        Regenerate database/sql/schema.sql from the models
  xian help             Show this help
`);
  process.exit(0);
}

const script = aliases[command] ?? command;
const fullCmd = `npm run ${script}${rest.length > 0 ? ` ${rest.join(" ")}` : ""}`;

try {
  execSync(fullCmd, { cwd: projectRoot, stdio: "inherit" });
} catch (error) {
  process.exit(error.status || 1);
}
