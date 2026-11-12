/**
 * An error that maps to an HTTP response. `code` is the stable machine-readable name
 * (for example "insufficient_stock"); `details` is extra structured context for the client.
 */
export class HttpError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Input failed validation. `details` is a list of `{ path, message }`. */
export class ValidationError extends HttpError {
  constructor(details = []) {
    super(422, "validation_failed", "Request validation failed", details);
    this.name = "ValidationError";
  }
}
