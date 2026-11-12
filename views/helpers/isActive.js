// {{#if (isActive currentPath "/sales")}}: true for the path itself or anything below it.
export default function isActive(path, prefix) {
  return (
    typeof path === "string" &&
    typeof prefix === "string" &&
    (path === prefix || path.startsWith(`${prefix}/`))
  );
}
