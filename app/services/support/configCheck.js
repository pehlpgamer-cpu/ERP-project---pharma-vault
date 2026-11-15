// Checks the business settings once, at start-up, so a typo in the environment stops the server from
// starting (with the variable named) instead of making every sale fail later at the till.
import { expiryBufferDays, varianceThreshold } from "./settings.js";
import { assertBusinessTimeZone } from "./time.js";

/** Throws an Error naming the first setting that is not usable. */
export function assertConfiguration() {
  varianceThreshold();
  expiryBufferDays();
  assertBusinessTimeZone();
}
