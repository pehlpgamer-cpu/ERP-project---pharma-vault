// Business settings read from the environment. Each is read when it is used, so a test can change the
// variable, and a bad value fails loudly instead of silently turning into a different rule.

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const WHOLE_DAYS = /^\d{1,4}$/;

/** The most the drawer may be over or short before closing a register needs a note (default 50.00). */
export function varianceThreshold() {
  const configured = (process.env.REGISTER_VARIANCE_THRESHOLD ?? "").trim();
  const value = configured === "" ? "50.00" : configured;

  if (!MONEY.test(value)) {
    throw new Error("REGISTER_VARIANCE_THRESHOLD must be an amount such as 50.00");
  }

  const [whole, fraction = ""] = value.split(".");

  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** How many days before its expiry date a batch stops being sold (default 0: the printed date is the last day). */
export function expiryBufferDays() {
  const configured = (process.env.EXPIRY_BUFFER_DAYS ?? "").trim();

  if (configured === "") {
    return 0;
  }

  if (!WHOLE_DAYS.test(configured)) {
    throw new Error("EXPIRY_BUFFER_DAYS must be a whole number of days such as 0");
  }

  return Number(configured);
}
