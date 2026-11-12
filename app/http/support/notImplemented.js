import { HttpError } from "../errors.js";

/**
 * Placeholder for a controller action that has no implementation yet. It answers 501 instead of
 * leaving the request hanging, so adding its route later cannot silently stall clients.
 */
export default function notImplemented() {
  throw new HttpError(501, "not_implemented", "This action is not implemented yet");
}
