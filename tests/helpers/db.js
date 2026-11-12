import { pool } from "../../database/client.js";

let tableNames = null;

/**
 * Throws unless the configured database is a test database. Every destructive helper calls this first.
 */
export function assertTestDatabase() {
  const name = process.env.MYSQL_DATABASE ?? "";

  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to touch database "${name}": its name must end with _test`);
  }
}

/**
 * Empties every base table of the test database (views are left alone).
 * One probe query finds the tables that hold rows, and only those are cleared: TRUNCATE on every
 * table cost over a second per test.
 */
export async function resetDatabase() {
  assertTestDatabase();

  const connection = await pool.getConnection();

  try {
    if (tableNames === null) {
      const [tables] = await connection.query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
      );
      tableNames = tables.map(({ name }) => {
        return name;
      });
    }

    const probe = tableNames
      .map((name) => {
        return `(SELECT '${name}' AS name FROM \`${name}\` LIMIT 1)`;
      })
      .join(" UNION ALL ");
    const [filled] = await connection.query(probe);

    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    for (const { name } of filled) {
      await connection.query(`DELETE FROM \`${name}\``);
    }

    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}
