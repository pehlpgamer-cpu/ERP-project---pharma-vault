/** True for a same-site absolute path. Rejects protocol-relative ("//host") and backslash tricks. */
export function isSafeReturnTo(url) {
  return (
    typeof url === "string" &&
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !url.startsWith("/\\")
  );
}
