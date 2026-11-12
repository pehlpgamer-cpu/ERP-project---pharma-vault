import { test } from "@japa/runner";
import { pool } from "../../../database/client.js";
import { assertTestDatabase } from "../../helpers/db.js";

test.group("database client", () => {
  test("connects to the test database", async ({ expect }) => {
    const [rows] = await pool.query("SELECT DATABASE() AS v");

    expect(rows[0].v.endsWith("_test")).toBe(true);
  });

  test("sessions run in UTC", async ({ expect }) => {
    const [rows] = await pool.query("SELECT @@session.time_zone AS v");

    expect(rows[0].v).toBe("+00:00");
  });

  test("DECIMAL arrives as a string", async ({ expect }) => {
    const [rows] = await pool.query("SELECT CAST(1.5 AS DECIMAL(10,2)) AS v");

    expect(rows[0].v).toBe("1.50");
  });

  test("assertTestDatabase refuses other databases", async ({ expect }) => {
    const original = process.env.MYSQL_DATABASE;
    process.env.MYSQL_DATABASE = "pharma_vault_dev";

    try {
      expect(() => {
        return assertTestDatabase();
      }).toThrow(/_test/);
    } finally {
      process.env.MYSQL_DATABASE = original;
    }
  });
});
