// {{#if (can "sales.create")}} or {{#if (can "sales.view.own" "sales.view.all")}}:
// true when the signed-in user holds any of the permissions (false when signed out).
// Reads `currentUser` from the root template data, which the loadUser middleware sets.
export default function can(...args) {
  const options = args.pop();
  const granted = options?.data?.root?.currentUser?.permissions ?? [];

  return args.some((name) => {
    return granted.includes(name);
  });
}
