const EIGHT_HOURS = 8 * 60 * 60 * 1000;

/**
 * express-session options. The cookie is httpOnly and SameSite=Lax; `secure` defaults to true in
 * production and can be overridden with SESSION_COOKIE_SECURE=true|false. Production refuses to
 * start without SECRET_KEY.
 */
export function sessionOptions(env = process.env) {
  const production = env.NODE_ENV === "production";

  if (production && !env.SECRET_KEY) {
    throw new Error("SECRET_KEY is required in production");
  }

  const override = env.SESSION_COOKIE_SECURE;
  const secure = override === undefined || override === "" ? production : override === "true";

  return {
    name: "pv.sid",
    secret: env.SECRET_KEY || "development-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure, maxAge: EIGHT_HOURS },
  };
}
