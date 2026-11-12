export const PERMISSIONS = Object.freeze({
  DASHBOARD_VIEW: "dashboard.view",
  SALES_VIEW_OWN: "sales.view.own",
  SALES_VIEW_BRANCH: "sales.view.branch",
  SALES_VIEW_ALL: "sales.view.all",
  SALES_CREATE: "sales.create",
  REGISTER_MANAGE: "register.manage",
  USERS_MANAGE: "users.manage",
  PRODUCTS_MANAGE: "products.manage",
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_MANAGE: "inventory.manage",
  INVENTORY_RECEIVE: "inventory.receive",
  PURCHASING_VIEW: "purchasing.view",
  PURCHASING_MANAGE: "purchasing.manage",
  PURCHASING_APPROVE: "purchasing.approve",
});

/** Which permissions each seeded role holds (the seed and the tests share this table). */
export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.values(PERMISSIONS)),
  pharmacist: Object.freeze([
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.SALES_VIEW_BRANCH,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.REGISTER_MANAGE,
    PERMISSIONS.PRODUCTS_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.INVENTORY_RECEIVE,
    PERMISSIONS.PURCHASING_VIEW,
    PERMISSIONS.PURCHASING_MANAGE,
  ]),
  cashier: Object.freeze([
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.SALES_VIEW_OWN,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.REGISTER_MANAGE,
  ]),
  accountant: Object.freeze([
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.SALES_VIEW_ALL,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.PURCHASING_VIEW,
  ]),
});

/** True when the user holds at least one of the named permissions. A null user holds none. */
export function can(user, ...names) {
  if (!user) {
    return false;
  }

  const granted = user.permissions ?? [];

  return names.some((name) => {
    return granted.includes(name);
  });
}
