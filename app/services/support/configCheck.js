// Checks the business settings once, at start-up, so a typo in the environment stops the server from
// starting (with the variable named) instead of making every sale fail later at the till.
import { expiryBufferDays, varianceThreshold } from "./settings.js";
import { assertBusinessTimeZone } from "./time.js";

/** Throws an Error naming the first setting that is not usable. */
export function assertConfiguration() {
  varianceThreshold();
  expiryBufferDays();
  assertBusinessTimeZone();
  assertIntegrationToken();
}

// Optional. When set it guards what other systems can read, so a guessable one is refused.
function assertIntegrationToken() {
  const token = process.env.INTEGRATION_API_TOKEN;

  if (token !== undefined && token !== "" && !/^[\x21-\x7e]{32,}$/.test(token)) {
    throw new Error(
      "INTEGRATION_API_TOKEN must be at least 32 visible characters without spaces (openssl rand -hex 32)",
    );
  }
}
