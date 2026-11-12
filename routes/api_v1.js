import express from "express";
const router = express.Router();
import { RouteBuilder } from "../src/RouteBuilder.js";
const routeBuilder = new RouteBuilder(router);

import healthController from "../app/http/controllers/api/v1/healthController.js";
import productsApiController from "../app/http/controllers/api/v1/productsController.js";
import salesApiController from "../app/http/controllers/api/v1/salesController.js";
import asyncHandler from "../app/http/middleware/asyncHandler.js";
import canSell from "../app/http/middleware/canSell.js";
import canViewSales from "../app/http/middleware/canViewSales.js";
import requireAuth from "../app/http/middleware/requireAuth.js";

// Health checks stay public; everything below needs a signed-in user.
router.get("/up", healthController.up);
router.get("/health", healthController.health);

router.use(requireAuth);

// Registered before the /:id route so "summary" is not read as an id.
router.get("/sales/summary", canViewSales, asyncHandler(salesApiController.summary));
routeBuilder.apiResource("/sales", salesApiController, {
  include: ["index", "show"],
  middleware: [canViewSales],
});

routeBuilder.apiResource("/products", productsApiController, {
  include: ["index"],
  middleware: [canSell],
});

export default router;
