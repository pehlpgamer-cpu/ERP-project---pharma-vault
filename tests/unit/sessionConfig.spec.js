import { test } from "@japa/runner";
import { sessionOptions } from "../../config/session.js";

test.group("sessionOptions", () => {
  test("production refuses to start without SECRET_KEY", ({ expect }) => {
    expect(() => {
      return sessionOptions({ NODE_ENV: "production" });
    }).toThrow(/SECRET_KEY/);
  });

  test("production cookie is httpOnly, lax, secure and lasts eight hours", ({ expect }) => {
    const options = sessionOptions({ NODE_ENV: "production", SECRET_KEY: "s" });

    expect(options.cookie).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 28_800_000,
    });
    expect(options.name).toBe("pv.sid");
    expect(options.secret).toBe("s");
  });

  test("SESSION_COOKIE_SECURE overrides the production default", ({ expect }) => {
    const options = sessionOptions({
      NODE_ENV: "production",
      SECRET_KEY: "s",
      SESSION_COOKIE_SECURE: "false",
    });

    expect(options.cookie.secure).toBe(false);
  });

  test("development works without a secret and does not require secure cookies", ({ expect }) => {
    const options = sessionOptions({ NODE_ENV: "development" });

    expect(typeof options.secret).toBe("string");
    expect(options.cookie.secure).toBe(false);
    expect(options.resave).toBe(false);
    expect(options.saveUninitialized).toBe(false);
  });
});
