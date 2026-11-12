import "dotenv/config";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { relations } from "../app/models/relations/relations.js";

// drizzle-orm 1.0.0-rc.4 reads `client.config` and calls `.promise()` itself, so it needs the
// callback-style pool from "mysql2". `pool` below is the promise view of the same pool.
const callbackPool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z",
  charset: "UTF8MB4_0900_AI_CI",
});

// TIMESTAMP columns follow the session time zone, so pin every new connection to UTC.
callbackPool.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/** One pooled MySQL client for the whole process. Data is stored and read as UTC. */
export const pool = callbackPool.promise();

export const db = drizzle({ client: callbackPool, relations, casing: "snake_case" });

export async function closeDb() {
  await pool.end();
}
