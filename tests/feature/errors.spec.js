import { test } from "@japa/runner";
import { TestSession } from "../helpers/http.js";

test.group("error responses over HTTP", () => {
  test("GET /api/v1/nope is a 404 JSON envelope", async ({ expect }) => {
    const response = await new TestSession().get("/api/v1/nope");

    expect(response.status).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  test("GET /nope with Accept text/html is a 404 page", async ({ expect }) => {
    const response = await new TestSession().get("/nope", { headers: { accept: "text/html" } });

    expect(response.status).toBe(404);
    expect(response.text).toContain("Page not found");
  });

  test("a malformed JSON body is a 422 envelope", async ({ expect }) => {
    const response = await new TestSession().request("POST", "/api/v1/nope", {
      headers: { "content-type": "application/json" },
      body: "{bad",
    });

    expect(response.status).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });
});
