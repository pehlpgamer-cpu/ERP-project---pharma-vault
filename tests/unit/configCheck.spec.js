import { test } from "@japa/runner";
import { assertConfiguration } from "../../app/services/support/configCheck.js";

// runs `fn` with these environment variables set (undefined removes one), then restores them
function withEnv(values, fn) {
  const saved = {};

  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const check = () => {
  assertConfiguration();
};

const GOOD = {
  APP_TIMEZONE: "Asia/Manila",
  EXPIRY_BUFFER_DAYS: "0",
  REGISTER_VARIANCE_THRESHOLD: "50.00",
};

test.group("startup configuration check", () => {
  test("a good configuration, and the defaults, pass", ({ expect }) => {
    withEnv(GOOD, () => {
      expect(check).not.toThrow();
    });
    withEnv(
      {
        APP_TIMEZONE: undefined,
        EXPIRY_BUFFER_DAYS: undefined,
        REGISTER_VARIANCE_THRESHOLD: undefined,
      },
      () => {
        expect(check).not.toThrow();
      },
    );
  });

  test("each bad value is named in the error, so the server refuses to start instead of failing at the till", ({
    expect,
  }) => {
    const bad = [
      [{ EXPIRY_BUFFER_DAYS: "thirty" }, "EXPIRY_BUFFER_DAYS"],
      [{ EXPIRY_BUFFER_DAYS: "-1" }, "EXPIRY_BUFFER_DAYS"],
      [{ REGISTER_VARIANCE_THRESHOLD: "5,00" }, "REGISTER_VARIANCE_THRESHOLD"],
      [{ REGISTER_VARIANCE_THRESHOLD: "-3" }, "REGISTER_VARIANCE_THRESHOLD"],
      [{ APP_TIMEZONE: "Mars/Phobos" }, "APP_TIMEZONE"],
      // a zone with daylight saving time would give wrong business days twice a year
      [{ APP_TIMEZONE: "America/New_York" }, "APP_TIMEZONE"],
    ];

    for (const [values, name] of bad) {
      withEnv({ ...GOOD, ...values }, () => {
        expect(check).toThrow(name);
      });
    }
  });
});
