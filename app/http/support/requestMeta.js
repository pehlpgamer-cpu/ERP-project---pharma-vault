/** The client address (capped to the 45 characters of an IPv6 text form) and user agent of a request. */
export function requestMeta(req) {
  const ip = req.ip ?? null;

  return {
    ipAddress: ip === null ? null : String(ip).slice(0, 45),
    userAgent: req.get?.("user-agent") ?? null,
  };
}
