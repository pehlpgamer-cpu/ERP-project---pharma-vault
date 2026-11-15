import { test } from "@japa/runner";
import * as z from "zod";
import { HttpError, ValidationError } from "../../app/http/errors.js";
import asyncHandler from "../../app/http/middleware/asyncHandler.js";
import { parse } from "../../app/services/support/validate.js";

test.group("asyncHandler", () => {
  test("forwards a rejected promise to next", async ({ expect }) => {
    const failure = new Error("boom");
    const received = [];

    await asyncHandler(async () => {
      throw failure;
    })({}, {}, (error) => {
      received.push(error);
    });

    expect(received).toEqual([failure]);
  });

  test("forwards a synchronous throw to next", async ({ expect }) => {
    const failure = new Error("sync boom");
    const received = [];

    await asyncHandler(() => {
      throw failure;
    })({}, {}, (error) => {
      received.push(error);
    });

    expect(received).toEqual([failure]);
  });

  test("does not call next when the handler resolves", async ({ expect }) => {
    const received = [];

    await asyncHandler(async () => {
      return "ok";
    })({}, {}, (error) => {
      received.push(error);
    });

    expect(received).toEqual([]);
  });
});

test.group("errors and parse", () => {
  test("HttpError carries status, code and details", ({ expect }) => {
    const error = new HttpError(409, "insufficient_stock", "Not enough", [{ productId: "p" }]);

    expect(error).toBeInstanceOf(Error);
    expect([error.status, error.code, error.message, error.details]).toEqual([
      409,
      "insufficient_stock",
      "Not enough",
      [{ productId: "p" }],
    ]);
  });

  test("parse returns the parsed data", ({ expect }) => {
    const schema = z.object({ email: z.email() });

    expect(parse(schema, { email: "a@x.test" })).toEqual({ email: "a@x.test" });
  });

  test("parse throws a ValidationError with dotted paths", ({ expect }) => {
    const schema = z.object({ email: z.email(), nested: z.object({ qty: z.number() }) });
    let error;

    try {
      parse(schema, { email: "nope", nested: { qty: "x" } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(HttpError);
    expect([error.status, error.code, error.message]).toEqual([
      422,
      "validation_failed",
      "Request validation failed",
    ]);
    expect(
      error.details.map((detail) => {
        return detail.path;
      }),
    ).toEqual(["email", "nested.qty"]);
  });
});
