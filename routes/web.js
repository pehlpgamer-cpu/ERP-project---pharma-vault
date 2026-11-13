import express from "express";
const router = express.Router();
import { RouteBuilder } from "../src/RouteBuilder.js";
const routeBuilder = new RouteBuilder(router);

import { homePage } from "../app/http/controllers/homeController.js";
import userController from "../app/http/controllers/userController.js";
import authController from "../app/http/controllers/authController.js";
import auditController from "../app/http/controllers/auditController.js";
import reportController from "../app/http/controllers/reportController.js";
import cashRegisterController from "../app/http/controllers/cashRegisterController.js";
import dashboardController from "../app/http/controllers/dashboardController.js";
import inventoryController from "../app/http/controllers/inventoryController.js";
import prescriptionController from "../app/http/controllers/prescriptionController.js";
import posController from "../app/http/controllers/posController.js";
import purchaseOrderController from "../app/http/controllers/purchaseOrderController.js";
import productController from "../app/http/controllers/productController.js";
import returnController from "../app/http/controllers/returnController.js";
import salesController from "../app/http/controllers/salesController.js";
import stockCountController from "../app/http/controllers/stockCountController.js";
import transferController from "../app/http/controllers/transferController.js";
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

const canStartReturn = requirePermission(PERMISSIONS.RETURNS_CREATE);
const canApproveReturn = requirePermission(PERMISSIONS.RETURNS_APPROVE);
const canSeeReturns = requirePermission(PERMISSIONS.RETURNS_CREATE, PERMISSIONS.RETURNS_APPROVE);

router.get(
  "/sales/:id/return",
  requireAuth,
  canStartReturn,
  asyncHandler(returnController.newForm),
);
router.post(
  "/sales/:id/returns",
  requireAuth,
  canStartReturn,
  asyncHandler(returnController.create),
);
router.get("/returns", requireAuth, canSeeReturns, asyncHandler(returnController.index));
router.get("/returns/:id", requireAuth, canSeeReturns, asyncHandler(returnController.show));

for (const [path, guard, handler] of [
  ["submit", canStartReturn, returnController.submit],
  ["cancel", canSeeReturns, returnController.cancel],
  ["approve", canApproveReturn, returnController.approve],
  ["reject", canApproveReturn, returnController.reject],
  ["process", canApproveReturn, returnController.process],
]) {
  router.post(`/returns/:id/${path}`, requireAuth, guard, asyncHandler(handler));
}

router.get(
  "/audit",
  requireAuth,
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  asyncHandler(auditController.index),
);
router.get(
  "/reports/movements",
  requireAuth,
  requirePermission(PERMISSIONS.INVENTORY_VIEW),
  asyncHandler(reportController.movements),
);

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

const canAdjustStock = requirePermission(PERMISSIONS.INVENTORY_ADJUST);
const canApproveStock = requirePermission(PERMISSIONS.INVENTORY_APPROVE);

// /stock-counts/new is registered before /stock-counts/:id so "new" is never read as an id.
router.get(
  "/stock-counts",
  requireAuth,
  canViewInventory,
  asyncHandler(stockCountController.index),
);
router.get(
  "/stock-counts/new",
  requireAuth,
  canAdjustStock,
  asyncHandler(stockCountController.newForm),
);
router.post(
  "/stock-counts",
  requireAuth,
  canAdjustStock,
  asyncHandler(stockCountController.create),
);
router.get(
  "/stock-counts/:id",
  requireAuth,
  canViewInventory,
  asyncHandler(stockCountController.show),
);

for (const [path, guard, handler] of [
  ["submit", canAdjustStock, stockCountController.submit],
  ["cancel", canAdjustStock, stockCountController.cancel],
  ["approve", canApproveStock, stockCountController.approve],
  ["reject", canApproveStock, stockCountController.reject],
  ["post", canApproveStock, stockCountController.post],
]) {
  router.post(`/stock-counts/:id/${path}`, requireAuth, guard, asyncHandler(handler));
}

const canRecordRx = requirePermission(PERMISSIONS.PRESCRIPTIONS_MANAGE);
const canVerifyRx = requirePermission(PERMISSIONS.PRESCRIPTIONS_VERIFY);
const canSeeRx = requirePermission(
  PERMISSIONS.PRESCRIPTIONS_MANAGE,
  PERMISSIONS.PRESCRIPTIONS_VERIFY,
);

// /prescriptions/new is registered before /prescriptions/:id so "new" is never read as an id.
router.get("/prescriptions", requireAuth, canSeeRx, asyncHandler(prescriptionController.index));
router.get("/prescriptions/new", requireAuth, canRecordRx, prescriptionController.newForm);
router.post(
  "/prescriptions",
  requireAuth,
  canRecordRx,
  asyncHandler(prescriptionController.create),
);
router.get("/prescriptions/:id", requireAuth, canSeeRx, asyncHandler(prescriptionController.show));
router.post(
  "/prescriptions/:id/verify",
  requireAuth,
  canVerifyRx,
  asyncHandler(prescriptionController.verify),
);
router.post(
  "/prescriptions/:id/revoke",
  requireAuth,
  canVerifyRx,
  asyncHandler(prescriptionController.revoke),
);
router.post(
  "/prescriptions/:id/reject",
  requireAuth,
  canVerifyRx,
  asyncHandler(prescriptionController.reject),
);

const canManageTransfers = requirePermission(PERMISSIONS.TRANSFERS_MANAGE);
const canApproveTransfers = requirePermission(PERMISSIONS.TRANSFERS_APPROVE);
const canSeeTransfers = requirePermission(
  PERMISSIONS.TRANSFERS_MANAGE,
  PERMISSIONS.TRANSFERS_APPROVE,
);

// /transfers/new is registered before /transfers/:id so "new" is never read as an id.
router.get("/transfers", requireAuth, canSeeTransfers, asyncHandler(transferController.index));
router.get(
  "/transfers/new",
  requireAuth,
  canManageTransfers,
  asyncHandler(transferController.newForm),
);
router.post("/transfers", requireAuth, canManageTransfers, asyncHandler(transferController.create));
router.get("/transfers/:id", requireAuth, canSeeTransfers, asyncHandler(transferController.show));

for (const [path, guard, handler] of [
  ["submit", canManageTransfers, transferController.submit],
  ["dispatch", canManageTransfers, transferController.dispatch],
  ["receive", canManageTransfers, transferController.receive],
  ["close", canManageTransfers, transferController.close],
  ["cancel", canSeeTransfers, transferController.cancel],
  ["approve", canApproveTransfers, transferController.approve],
  ["reject", canApproveTransfers, transferController.reject],
]) {
  router.post(`/transfers/:id/${path}`, requireAuth, guard, asyncHandler(handler));
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
