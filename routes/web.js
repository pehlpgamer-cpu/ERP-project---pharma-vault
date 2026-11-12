import express from "express";
const router = express.Router();
import { RouteBuilder } from "../src/RouteBuilder.js";
const routeBuilder = new RouteBuilder(router);

import { homePage } from "../app/http/controllers/homeController.js";
import userController from "../app/http/controllers/userController.js";
import authController from "../app/http/controllers/authController.js";
import dashboardController from "../app/http/controllers/dashboardController.js";
import salesController from "../app/http/controllers/salesController.js";
import asyncHandler from "../app/http/middleware/asyncHandler.js";
import canViewSales from "../app/http/middleware/canViewSales.js";
import requireAuth from "../app/http/middleware/requireAuth.js";
import requirePermission from "../app/http/middleware/requirePermission.js";
import { PERMISSIONS } from "../app/services/auth/permissions.js";

router.get("/", homePage);

router.get("/register-page", authController.registerPage);
router.get("/forgot-password-page", authController.forgotPasswordPage);
router.get("/dashboard-page", requireAuth, asyncHandler(dashboardController.index));
router.get("/login-page", authController.loginPage);

router.get("/sales", requireAuth, canViewSales, asyncHandler(salesController.index));
router.get("/sales/:id", requireAuth, canViewSales, asyncHandler(salesController.show));

router.post("/login", asyncHandler(authController.login));
router.post("/register", asyncHandler(authController.register));
router.post("/logout", asyncHandler(authController.logout));

routeBuilder.resource("/users", userController, {
  include: ["index"],
  middleware: [requireAuth, requirePermission(PERMISSIONS.USERS_MANAGE)],
});
export default router;
