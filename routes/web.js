import express from "express";
const router = express.Router();
import { RouteBuilder } from "../src/RouteBuilder.js";
const routeBuilder = new RouteBuilder(router);

import { homePage } from "../app/http/controllers/homeController.js";
import userController from "../app/http/controllers/userController.js";
import authController from "../app/http/controllers/authController.js";
import cashRegisterController from "../app/http/controllers/cashRegisterController.js";
import dashboardController from "../app/http/controllers/dashboardController.js";
import inventoryController from "../app/http/controllers/inventoryController.js";
import posController from "../app/http/controllers/posController.js";
import purchaseOrderController from "../app/http/controllers/purchaseOrderController.js";
import productController from "../app/http/controllers/productController.js";
import salesController from "../app/http/controllers/salesController.js";
import supplierController from "../app/http/controllers/supplierController.js";
import asyncHandler from "../app/http/middleware/asyncHandler.js";
import canSell from "../app/http/middleware/canSell.js";
import canViewSales from "../app/http/middleware/canViewSales.js";
import requireAuth from "../app/http/middleware/requireAuth.js";
import requirePermission from "../app/http/middleware/requirePermission.js";
import { PERMISSIONS } from "../app/services/auth/permissions.js";

router.get("/", homePage);

router.get("/register-page", authController.registerPage);
router.get("/forgot-password-page", authController.forgotPasswordPage);
router.get("/dashboard-page", requireAuth, asyncHandler(dashboardController.index));
router.get("/login-page", authController.loginPage);

router.get("/pos-page", requireAuth, canSell, asyncHandler(posController.page));

router.get("/sales", requireAuth, canViewSales, asyncHandler(salesController.index));
router.get("/sales/:id", requireAuth, canViewSales, asyncHandler(salesController.show));

const canManageProducts = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);

// /products/create is registered before /products/:id/... so "create" is never read as an id.
router.get("/products", requireAuth, canManageProducts, asyncHandler(productController.index));
router.get(
  "/products/create",
  requireAuth,
  canManageProducts,
  asyncHandler(productController.create),
);
router.post("/products", requireAuth, canManageProducts, asyncHandler(productController.store));
router.get(
  "/products/:id/edit",
  requireAuth,
  canManageProducts,
  asyncHandler(productController.edit),
);
router.post(
  "/products/:id/status",
  requireAuth,
  canManageProducts,
  asyncHandler(productController.status),
);
router.post(
  "/products/:id",
  requireAuth,
  canManageProducts,
  asyncHandler(productController.update),
);

const canViewInventory = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const canManageInventory = requirePermission(PERMISSIONS.INVENTORY_MANAGE);

router.get("/inventory", requireAuth, canViewInventory, asyncHandler(inventoryController.index));
router.get(
  "/inventory/batches",
  requireAuth,
  canViewInventory,
  asyncHandler(inventoryController.batches),
);

for (const [path, handler] of [
  ["quarantine", inventoryController.quarantine],
  ["release", inventoryController.release],
  ["recall", inventoryController.recall],
  ["write-off", inventoryController.writeOff],
]) {
  router.post(
    `/inventory/batches/:id/${path}`,
    requireAuth,
    canManageInventory,
    asyncHandler(handler),
  );
}

const canViewPurchasing = requirePermission(PERMISSIONS.PURCHASING_VIEW);
const canManagePurchasing = requirePermission(PERMISSIONS.PURCHASING_MANAGE);
const canApprovePurchasing = requirePermission(PERMISSIONS.PURCHASING_APPROVE);
const canReceiveStock = requirePermission(PERMISSIONS.INVENTORY_RECEIVE);

router.get("/suppliers", requireAuth, canViewPurchasing, asyncHandler(supplierController.index));
router.get("/suppliers/new", requireAuth, canManagePurchasing, supplierController.newForm);
router.post(
  "/suppliers",
  requireAuth,
  canManagePurchasing,
  asyncHandler(supplierController.create),
);
router.get(
  "/suppliers/:id/edit",
  requireAuth,
  canManagePurchasing,
  asyncHandler(supplierController.editForm),
);
router.post(
  "/suppliers/:id",
  requireAuth,
  canManagePurchasing,
  asyncHandler(supplierController.update),
);

router.get(
  "/purchase-orders",
  requireAuth,
  canViewPurchasing,
  asyncHandler(purchaseOrderController.index),
);
router.get(
  "/purchase-orders/new",
  requireAuth,
  canManagePurchasing,
  asyncHandler(purchaseOrderController.newForm),
);
router.post(
  "/purchase-orders",
  requireAuth,
  canManagePurchasing,
  asyncHandler(purchaseOrderController.create),
);
router.get(
  "/purchase-orders/:id",
  requireAuth,
  canViewPurchasing,
  asyncHandler(purchaseOrderController.show),
);
router.get(
  "/purchase-orders/:id/edit",
  requireAuth,
  canManagePurchasing,
  asyncHandler(purchaseOrderController.editForm),
);
router.post(
  "/purchase-orders/:id",
  requireAuth,
  canManagePurchasing,
  asyncHandler(purchaseOrderController.update),
);

for (const [path, guard, handler] of [
  ["submit", canManagePurchasing, purchaseOrderController.submit],
  ["return", canApprovePurchasing, purchaseOrderController.return],
  ["approve", canApprovePurchasing, purchaseOrderController.approve],
  ["send", canManagePurchasing, purchaseOrderController.send],
  ["cancel", canManagePurchasing, purchaseOrderController.cancel],
  ["close", canManagePurchasing, purchaseOrderController.close],
]) {
  router.post(`/purchase-orders/:id/${path}`, requireAuth, guard, asyncHandler(handler));
}

router.get(
  "/purchase-orders/:id/receive",
  requireAuth,
  canReceiveStock,
  asyncHandler(purchaseOrderController.receiveForm),
);
router.post(
  "/purchase-orders/:id/receive",
  requireAuth,
  canReceiveStock,
  asyncHandler(purchaseOrderController.receive),
);

const canManageRegister = requirePermission(PERMISSIONS.REGISTER_MANAGE);

router.get(
  "/cash-register-page",
  requireAuth,
  canManageRegister,
  asyncHandler(cashRegisterController.index),
);
router.post(
  "/cash-register/open",
  requireAuth,
  canManageRegister,
  asyncHandler(cashRegisterController.open),
);
router.post(
  "/cash-register/close",
  requireAuth,
  canManageRegister,
  asyncHandler(cashRegisterController.close),
);

router.post("/login", asyncHandler(authController.login));
router.post("/register", asyncHandler(authController.register));
router.post("/logout", asyncHandler(authController.logout));

routeBuilder.resource("/users", userController, {
  include: ["index"],
  middleware: [requireAuth, requirePermission(PERMISSIONS.USERS_MANAGE)],
});
export default router;
