import { test } from "@japa/runner";
import { assertConfiguration } from "../../app/services/support/configCheck.js";
import { resetDatabase } from "../helpers/db.js";
import { makeProduct } from "../helpers/factories.js";
import { TestSession } from "../helpers/http.js";

const TOKEN = "t".repeat(40);
const PATH = "/api/v1/integrations/medicines";

function withToken(value, fn) {
  const saved = process.env.INTEGRATION_API_TOKEN;

  if (value === undefined) {
    delete process.env.INTEGRATION_API_TOKEN;
  } else {
    process.env.INTEGRATION_API_TOKEN = value;
  }

  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) {
      delete process.env.INTEGRATION_API_TOKEN;
    } else {
      process.env.INTEGRATION_API_TOKEN = saved;
    }
  });
}

const bearer = { authorization: `Bearer ${TOKEN}` };

test.group("integration API: medicine search for other systems", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("a bearer token or an X-API-Key returns name, generic name, brands and ACTIVE status", async ({
    expect,
  }) => {
    await makeProduct({
      name: "Biogesic 500 mg",
      genericName: "Paracetamol",
      brandName: "Biogesic",
    });

    await withToken(TOKEN, async () => {
      const viaBearer = await new TestSession().get(`${PATH}?q=paracet`, { headers: bearer });
      const viaKey = await new TestSession().get(`${PATH}?q=paracet`, {
        headers: { "x-api-key": TOKEN },
      });

      expect(viaBearer.status).toBe(200);
      expect(viaBearer.json().data).toEqual([
        {
          sku: expect.any(String),
          name: "Biogesic 500 mg",
          genericName: "Paracetamol",
          brandNames: ["Biogesic"],
          strength: null,
          dosageForm: null,
          requiresPrescription: false,
          status: "ACTIVE",
        },
      ]);
      expect(viaKey.json()).toEqual(viaBearer.json());
    });
  });

  test("nothing about price, cost or stock leaves the building", async ({ expect }) => {
    await makeProduct({
      name: "Amoxicillin",
      units: [{ name: "Capsule", factor: "1", base: true, price: "9.0000" }],
    });

    await withToken(TOKEN, async () => {
      const response = await new TestSession().get(`${PATH}?q=amox`, { headers: bearer });

      expect(Object.keys(response.json().data[0]).sort()).toEqual([
        "brandNames",
        "dosageForm",
        "genericName",
        "name",
        "requiresPrescription",
        "sku",
        "status",
        "strength",
      ]);
    });
  });

  test("inactive products and products with nothing sellable are not listed", async ({
    expect,
  }) => {
    await makeProduct({ name: "Retired Zed", isActive: false });
    await makeProduct({ name: "Unsellable Zed", units: [] });
    await makeProduct({ name: "Live Zed" });

    await withToken(TOKEN, async () => {
      const response = await new TestSession().get(`${PATH}?q=zed`, { headers: bearer });

      expect(
        response.json().data.map((item) => {
          return item.name;
        }),
      ).toEqual(["Live Zed"]);
    });
  });

  test("wildcards in the search match literally, and no match is an empty list", async ({
    expect,
  }) => {
    await makeProduct({ name: "Plain Syrup" });

    await withToken(TOKEN, async () => {
      const wild = await new TestSession().get(`${PATH}?q=${encodeURIComponent("%")}`, {
        headers: bearer,
      });
      const none = await new TestSession().get(`${PATH}?q=nothinghere`, { headers: bearer });

      expect(wild.json().data).toEqual([]);
      expect(none.json().data).toEqual([]);
    });
  });

  test("a missing, wrong or look-alike token is refused with 401", async ({ expect }) => {
    await makeProduct({ name: "Secret Pill" });

    await withToken(TOKEN, async () => {
      const refused = [
        {},
        { authorization: "Bearer wrong" },
        { authorization: `Bearer ${TOKEN}x` },
        { authorization: TOKEN },
        { "x-api-key": TOKEN.slice(1) },
      ];

      for (const headers of refused) {
        const response = await new TestSession().get(`${PATH}?q=secret`, { headers });

        expect(response.status).toBe(401);
        expect(response.text).not.toContain("Secret Pill");
      }
    });
  });

  test("with no token configured the endpoint is off (503), even for an empty token", async ({
    expect,
  }) => {
    await withToken(undefined, async () => {
      const off = await new TestSession().get(`${PATH}?q=a`, { headers: bearer });
      const empty = await new TestSession().get(`${PATH}?q=a`, { headers: { "x-api-key": "" } });

      expect(off.status).toBe(503);
      expect(empty.status).toBe(503);
    });
    await withToken("", async () => {
      const response = await new TestSession().get(`${PATH}?q=a`, { headers: { "x-api-key": "" } });

      expect(response.status).toBe(503);
    });
  });

  test("a bad query is a 422, not a 500", async ({ expect }) => {
    await withToken(TOKEN, async () => {
      const missing = await new TestSession().get(PATH, { headers: bearer });
      const tooMany = await new TestSession().get(`${PATH}?q=a&limit=51`, { headers: bearer });

      expect(missing.status).toBe(422);
      expect(tooMany.status).toBe(422);
    });
  });

  test("the token cannot open the rest of the API", async ({ expect }) => {
    await withToken(TOKEN, async () => {
      const products = await new TestSession().get("/api/v1/products?q=a", { headers: bearer });
      const sales = await new TestSession().get("/api/v1/sales", { headers: bearer });

      expect(products.status).toBe(401);
      expect(sales.status).toBe(401);
    });
  });

  test("start-up refuses a short or spaced token and accepts none or a long one", async ({
    expect,
  }) => {
    await withToken("short", async () => {
      expect(() => {
        assertConfiguration();
      }).toThrow("INTEGRATION_API_TOKEN");
    });
    await withToken(`${"a".repeat(20)} ${"b".repeat(20)}`, async () => {
      expect(() => {
        assertConfiguration();
      }).toThrow("INTEGRATION_API_TOKEN");
    });
    await withToken(TOKEN, async () => {
      expect(() => {
        assertConfiguration();
      }).not.toThrow();
    });
    await withToken(undefined, async () => {
      expect(() => {
        assertConfiguration();
      }).not.toThrow();
    });
  });
});
