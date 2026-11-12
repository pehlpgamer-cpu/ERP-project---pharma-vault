import { test } from "@japa/runner";
import { HttpError } from "../../app/http/errors.js";
import { errorHandler, notFound } from "../../app/http/middleware/errorHandler.js";
import wantsJson from "../../app/http/support/wantsJson.js";

function fakeRes() {
  const res = { statusCode: 200, headersSent: false, body: undefined, rendered: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.render = (view, data, callback) => {
    res.rendered = { view, data };
    callback?.(null, "<html></html>");
  };
  res.send = (payload) => {
    res.sent = payload;
    return res;
  };
  res.type = () => {
    return res;
  };
  return res;
}

function fakeReq(url, accepted = "html") {
  return {
    originalUrl: url,
    accepts: () => {
      return accepted;
    },
  };
}

function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => {
    logged.push(args);
  };

  try {
    return { result: fn(), logged };
  } finally {
    console.error = original;
  }
}

test.group("wantsJson", () => {
  test("API paths and JSON-preferring requests want JSON", ({ expect }) => {
    expect(wantsJson(fakeReq("/api/v1/sales"))).toBe(true);
    expect(wantsJson(fakeReq("/sales", "json"))).toBe(true);
    expect(wantsJson(fakeReq("/sales", "html"))).toBe(false);
  });
});

test.group("errorHandler", () => {
  test("notFound forwards a 404 HttpError", ({ expect }) => {
    let forwarded;

    notFound(fakeReq("/nope"), fakeRes(), (error) => {
      forwarded = error;
    });

    expect([forwarded.status, forwarded.code]).toEqual([404, "not_found"]);
  });

  test("JSON request: HttpError maps to its envelope", ({ expect }) => {
    const res = fakeRes();

    errorHandler(
      new HttpError(409, "insufficient_stock", "m", [{ a: 1 }]),
      fakeReq("/api/v1/x"),
      res,
      () => {},
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: { code: "insufficient_stock", message: "m", details: [{ a: 1 }] },
    });
  });

  test("JSON request: an unknown error is a generic 500 and is logged", ({ expect }) => {
    const res = fakeRes();

    const { logged } = quietly(() => {
      return errorHandler(new Error("secret detail"), fakeReq("/api/v1/x"), res, () => {});
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: { code: "server_error", message: "Something went wrong", details: [] },
    });
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
    expect(logged).toHaveLength(1);
  });

  test("a malformed JSON body becomes a 422 validation envelope", ({ expect }) => {
    const res = fakeRes();
    const parseError = Object.assign(new Error("Unexpected token"), {
      type: "entity.parse.failed",
      status: 400,
    });

    errorHandler(parseError, fakeReq("/api/v1/x"), res, () => {});

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.details).toEqual([{ path: "body", message: "Malformed JSON" }]);
  });

  test("HTML request in production hides the stack", ({ expect }) => {
    const res = fakeRes();
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      quietly(() => {
        return errorHandler(new Error("boom"), fakeReq("/sales"), res, () => {});
      });
    } finally {
      process.env.NODE_ENV = original;
    }

    expect(res.statusCode).toBe(500);
    expect(res.rendered.view).toBe("errors/error");
    expect(res.rendered.data.detail).toBeNull();
    expect(res.rendered.data.heading).toBe("Something went wrong");
  });

  test("HTML request outside production shows the error detail", ({ expect }) => {
    const res = fakeRes();

    quietly(() => {
      return errorHandler(new Error("boom"), fakeReq("/sales"), res, () => {});
    });

    expect(res.rendered.data.detail).toContain("boom");
  });

  test("headings follow the status", ({ expect }) => {
    const headings = {};

    for (const status of [401, 403, 404]) {
      const res = fakeRes();
      errorHandler(new HttpError(status, "x", "m"), fakeReq("/sales"), res, () => {});
      headings[status] = res.rendered.data.heading;
    }

    expect(headings).toEqual({
      401: "Sign in required",
      403: "Access denied",
      404: "Page not found",
    });
  });

  test("delegates to the next handler once headers are sent", ({ expect }) => {
    const res = fakeRes();
    res.headersSent = true;
    const failure = new Error("late");
    let forwarded;

    errorHandler(failure, fakeReq("/x"), res, (error) => {
      forwarded = error;
    });

    expect(forwarded).toBe(failure);
  });
});
