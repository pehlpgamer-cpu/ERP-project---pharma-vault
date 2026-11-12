/**
 * True when the client should get JSON: API paths always, other paths when the Accept header
 * prefers JSON over HTML.
 */
export default function wantsJson(req) {
  if ((req.originalUrl ?? "").startsWith("/api/")) {
    return true;
  }

  return req.accepts(["html", "json"]) === "json";
}
