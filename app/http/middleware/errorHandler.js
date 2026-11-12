import { HttpError, ValidationError } from "../errors.js";
import wantsJson from "../support/wantsJson.js";

const HEADINGS = {
  401: "Sign in required",
  403: "Access denied",
  404: "Page not found",
  500: "Something went wrong",
};

/** Closes the route stack: anything that reaches it matched no route. */
export function notFound(req, res, next) {
  next(new HttpError(404, "not_found", "Not found"));
}

// Errors the client caused or can act on. Returns null for everything unexpected.
function toHttpError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  if (error?.type === "entity.parse.failed") {
    return new ValidationError([{ path: "body", message: "Malformed JSON" }]);
  }

  return null;
}

/**
 * Central error handler. API clients get the JSON envelope; browsers get the error page.
 * Unexpected errors are logged and never leak their message or stack outside development and test.
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const known = toHttpError(error);
  const status = known?.status ?? 500;
  const message = known?.message ?? "Something went wrong";

  if (known === null) {
    console.error(error);
  }

  if (wantsJson(req)) {
    return res.status(status).json({
      error: { code: known?.code ?? "server_error", message, details: known?.details ?? [] },
    });
  }

  const heading = HEADINGS[status] ?? "Request failed";
  const inProduction = process.env.NODE_ENV === "production";
  const data = {
    pageTitle: heading,
    layout: res.locals?.currentUser ? "authenticated" : "main",
    status,
    heading,
    message: status === 404 ? "The page you asked for does not exist." : message,
    detail: known === null && !inProduction ? (error?.stack ?? String(error)) : null,
  };

  return res.status(status).render("errors/error", data, (renderError, html) => {
    if (renderError) {
      console.error(renderError);

      return res.type("text/plain").send("Something went wrong");
    }

    return res.send(html);
  });
}
