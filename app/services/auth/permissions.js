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
  INVENTORY_ADJUST: "inventory.adjust",
  INVENTORY_APPROVE: "inventory.approve",
  PURCHASING_VIEW: "purchasing.view",
  PURCHASING_MANAGE: "purchasing.manage",
  PURCHASING_APPROVE: "purchasing.approve",
  RETURNS_CREATE: "returns.create",
  RETURNS_APPROVE: "returns.approve",
  TRANSFERS_MANAGE: "transfers.manage",
  TRANSFERS_APPROVE: "transfers.approve",
  PRESCRIPTIONS_MANAGE: "prescriptions.manage",
  PRESCRIPTIONS_VERIFY: "prescriptions.verify",
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
    PERMISSIONS.INVENTORY_ADJUST,
    PERMISSIONS.PURCHASING_VIEW,
    PERMISSIONS.PURCHASING_MANAGE,
    PERMISSIONS.RETURNS_CREATE,
    PERMISSIONS.RETURNS_APPROVE,
    PERMISSIONS.TRANSFERS_MANAGE,
    PERMISSIONS.PRESCRIPTIONS_MANAGE,
    PERMISSIONS.PRESCRIPTIONS_VERIFY,
  ]),
  cashier: Object.freeze([
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.SALES_VIEW_OWN,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.REGISTER_MANAGE,
    PERMISSIONS.RETURNS_CREATE,
    PERMISSIONS.PRESCRIPTIONS_MANAGE,
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
