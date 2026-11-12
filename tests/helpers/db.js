import { pool } from "../../database/client.js";

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
 */
export async function resetDatabase() {
  assertTestDatabase();

  const connection = await pool.getConnection();

  try {
    const [tables] = await connection.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
    );

    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    for (const { name } of tables) {
      await connection.query(`TRUNCATE TABLE \`${name}\``);
    }

    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}
