import dotenv from "dotenv";
import { configure, processCLIArgs, run } from "@japa/runner";
import { expect } from "@japa/expect";
import { apiClient } from "@japa/api-client";
import { expectTypeOf } from "@japa/expect-type";

// The test environment must be in place before any application module reads process.env.
dotenv.config({ path: ".env.test", override: true });
process.env.NODE_ENV = "test";

const { default: app, bootstrap } = await import("../src/app.js");
const { closeDb } = await import("../database/client.js");

await bootstrap();

const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => {
    resolve(listening);
  });
});
process.env.TEST_BASE_URL = `http://127.0.0.1:${server.address().port}`;

processCLIArgs(process.argv.splice(2));
configure({
  suites: [
    { name: "unit", timeout: 20 * 1000, files: ["tests/unit/**/*.spec.js"] },
    { name: "feature", timeout: 20 * 1000, files: ["tests/feature/**/*.spec.js"] },
  ],
  plugins: [expect(), apiClient(process.env.TEST_BASE_URL), expectTypeOf()],
  teardown: [
    async () => {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await closeDb();
    },
  ],
});

run();
