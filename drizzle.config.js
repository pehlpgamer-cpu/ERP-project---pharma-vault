import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./database/migrations",
  schema: "./app/models",
  dialect: "mysql",
  // tablesFilter: [
  //   "users",
  //   "roles",
  // ],
  dbCredentials: {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  },
  casing: "snake_case",
  verbose: true,
  // `strict` asks for confirmation before every push; automated runs (the test database) set DRIZZLE_STRICT=false.
  strict: process.env.DRIZZLE_STRICT !== "false",
});
