import { test } from "@japa/runner";
import { HttpError } from "../../app/http/errors.js";
import requireAuth from "../../app/http/middleware/requireAuth.js";
import requirePermission from "../../app/http/middleware/requirePermission.js";
import { isSafeReturnTo } from "../../app/http/support/returnTo.js";

function fakeReq(overrides = {}) {
  const flashed = [];

  return {
    method: "GET",
    originalUrl: "/sales?page=2",
    session: {},
    user: null,
    flashed,
    flash(type, message) {
      flashed.push([type, message]);
    },
    accepts() {
      return "html";
    },
    ...overrides,
  };
}

function fakeRes() {
  return {
    redirectedTo: null,
    redirect(url) {
      this.redirectedTo = url;
    },
  };
}

test.group("requireAuth", () => {
  test("lets a signed-in user through", ({ expect }) => {
    const calls = [];

    requireAuth(fakeReq({ user: { id: "u" } }), fakeRes(), (error) => {
      calls.push(error);
    });

    expect(calls).toEqual([undefined]);
  });

  test("an API request without a session is a 401 unauthenticated", ({ expect }) => {
    let forwarded;

    requireAuth(fakeReq({ originalUrl: "/api/v1/sales" }), fakeRes(), (error) => {
      forwarded = error;
    });

    expect(forwarded).toBeInstanceOf(HttpError);
    expect([forwarded.status, forwarded.code]).toEqual([401, "unauthenticated"]);
  });

  test("a page request remembers the target, flashes and redirects to the login page", ({
    expect,
  }) => {
    const req = fakeReq();
    const res = fakeRes();

    requireAuth(req, res, () => {});

    expect(req.session.returnTo).toBe("/sales?page=2");
    expect(req.flashed).toEqual([["error_msg", "Please sign in"]]);
    expect(res.redirectedTo).toBe("/login-page");
  });

  test("a non-GET request does not store a return target", ({ expect }) => {
    const req = fakeReq({ method: "POST" });

    requireAuth(req, fakeRes(), () => {});

    expect(req.session.returnTo).toBeUndefined();
  });
});

test.group("requirePermission", () => {
  test("passes when the user holds one of the names", ({ expect }) => {
    const calls = [];

    requirePermission("a", "b")({ user: { permissions: ["b"] } }, {}, (error) => {
      calls.push(error);
    });

    expect(calls).toEqual([undefined]);
  });

  test("forwards a 403 forbidden otherwise", ({ expect }) => {
    let forwarded;

    requirePermission("a")({ user: { permissions: ["b"] } }, {}, (error) => {
      forwarded = error;
    });

    expect(forwarded).toBeInstanceOf(HttpError);
    expect([forwarded.status, forwarded.code]).toEqual([403, "forbidden"]);
  });
});

test.group("isSafeReturnTo", () => {
  test("accepts only same-site absolute paths", ({ expect }) => {
    expect(isSafeReturnTo("/sales?page=2")).toBe(true);
    expect(isSafeReturnTo("//evil.com")).toBe(false);
    expect(isSafeReturnTo("/\\evil")).toBe(false);
    expect(isSafeReturnTo("https://evil.com")).toBe(false);
    expect(isSafeReturnTo("")).toBe(false);
    expect(isSafeReturnTo(null)).toBe(false);
  });
});
