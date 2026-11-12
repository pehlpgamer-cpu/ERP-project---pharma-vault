import { test } from "@japa/runner";
import auditTrailController from "../../app/http/controllers/auditTrailController.js";
import userController from "../../app/http/controllers/userController.js";
import { HttpError } from "../../app/http/errors.js";

function failureOf(handler) {
  try {
    handler({}, {});
  } catch (error) {
    return error;
  }

  return null;
}

test.group("unfinished controller handlers", () => {
  test("every unfinished user handler is a 501 not_implemented", ({ expect }) => {
    for (const name of ["show", "store", "update", "replace", "destroy", "create", "edit"]) {
      const error = failureOf(userController[name]);

      expect(error).toBeInstanceOf(HttpError);
      expect([name, error.status, error.code]).toEqual([name, 501, "not_implemented"]);
    }
  });

  test("every audit trail handler is a 501 not_implemented", ({ expect }) => {
    for (const name of [
      "index",
      "show",
      "store",
      "update",
      "replace",
      "destroy",
      "create",
      "edit",
    ]) {
      const error = failureOf(auditTrailController[name]);

      expect([name, error?.status, error?.code]).toEqual([name, 501, "not_implemented"]);
    }
  });
});
