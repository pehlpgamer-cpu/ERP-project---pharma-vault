import { test } from "@japa/runner";
import { resetDatabase } from "../helpers/db.js";
import { makeUser } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

test.group("error responses over HTTP", (group) => {
  group.each.setup(async () => {
    await resetDatabase();
  });

  test("an unknown API path is a 401 envelope when signed out and a 404 envelope when signed in", async ({
    expect,
  }) => {
    const signedOut = await new TestSession().get("/api/v1/nope");
    const signedIn = await (await loginAs(await makeUser())).get("/api/v1/nope");

    // The API router authenticates before routing, so signed-out clients cannot probe which paths exist.
    expect([signedOut.status, signedOut.json().error.code]).toEqual([401, "unauthenticated"]);
    expect([signedIn.status, signedIn.json().error.code]).toEqual([404, "not_found"]);
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
