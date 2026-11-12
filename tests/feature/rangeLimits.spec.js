import { test } from "@japa/runner";
import { resetDatabase } from "../helpers/db.js";
import { makeWorld } from "../helpers/factories.js";
import { loginAs } from "../helpers/http.js";

const HTML = { headers: { accept: "text/html" } };

test.group("date ranges on the sales API and pages", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a summary over an absurd range is a quick 422, not seconds of CPU for every till", async ({
    expect,
  }) => {
    const session = await loginAs((await makeWorld()).cashier);
    const started = Date.now();

    const response = await session.get("/api/v1/sales/summary?from=0001-01-01&to=9999-12-30");

    expect([response.status, response.json().error.code]).toEqual([422, "validation_failed"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a summary spans at most 366 days, and a missing `to` means today", async ({ expect }) => {
    const session = await loginAs((await makeWorld()).cashier);
    const statuses = {};

    for (const query of [
      "from=2026-01-01&to=2026-12-31", // 365 days
      "from=2024-01-01&to=2024-12-31", // 366 days (a leap year)
      "from=2024-01-01&to=2025-01-01", // 367 days
      "from=2000-01-01", // up to today
      "to=2026-11-12", // 30 days back from `to`
    ]) {
      statuses[query] = (await session.get(`/api/v1/sales/summary?${query}`)).status;
    }

    expect(statuses).toEqual({
      "from=2026-01-01&to=2026-12-31": 200,
      "from=2024-01-01&to=2024-12-31": 200,
      "from=2024-01-01&to=2025-01-01": 422,
      "from=2000-01-01": 422,
      "to=2026-11-12": 200,
    });
  });

  test("dates outside 2000-01-01 to 2099-12-31 are a 422 on the list and the summary, never a 500", async ({
    expect,
  }) => {
    const session = await loginAs((await makeWorld()).cashier);

    for (const path of [
      "/api/v1/sales?to=9999-12-31",
      "/api/v1/sales?from=1999-12-31",
      "/api/v1/sales?from=2100-01-01",
      "/api/v1/sales/summary?from=2099-12-30&to=2100-01-01",
    ]) {
      const response = await session.get(path);

      expect([path, response.status, response.json().error.code]).toEqual([
        path,
        422,
        "validation_failed",
      ]);
    }
  });

  test("the sales page shows the message and the default list for an out-of-range date", async ({
    expect,
  }) => {
    const session = await loginAs((await makeWorld()).cashier);

    const response = await session.get("/sales?to=9999-12-31", HTML);

    expect(response.status).toBe(200);
    expect(response.text).toContain("Date must be between 2000-01-01 and 2099-12-31");
  });
});
