import express from "express";
const router = express.Router();
import { RouteBuilder } from "../src/RouteBuilder.js";
const routeBuilder = new RouteBuilder(router);

import healthController from "../app/http/controllers/api/v1/healthController.js";
import integrationsApiController from "../app/http/controllers/api/v1/integrationsController.js";
import prescriptionsApiController from "../app/http/controllers/api/v1/prescriptionsController.js";
import productsApiController from "../app/http/controllers/api/v1/productsController.js";
import salesApiController from "../app/http/controllers/api/v1/salesController.js";
import asyncHandler from "../app/http/middleware/asyncHandler.js";
import canSell from "../app/http/middleware/canSell.js";
import canViewSales from "../app/http/middleware/canViewSales.js";
import integrationToken from "../app/http/middleware/integrationToken.js";
import requireAuth from "../app/http/middleware/requireAuth.js";

// Health checks stay public; everything below needs a signed-in user.
router.get("/up", healthController.up);
router.get("/health", healthController.health);

// Other systems (the pharmacy queue) read the medicine list with a shared token, not a user session.
router.get(
  "/integrations/medicines",
  integrationToken,
  asyncHandler(integrationsApiController.medicines),
);

router.use(requireAuth);

// Registered before the /:id route so "summary" is not read as an id.
router.get("/sales/summary", canViewSales, asyncHandler(salesApiController.summary));
routeBuilder.apiResource("/sales", salesApiController, {
  include: ["index", "show"],
  middleware: [canViewSales],
});
// Selling needs sales.create only: whoever rings up a sale gets its detail back.
router.post("/sales", canSell, asyncHandler(salesApiController.store));

router.get("/prescriptions/lookup", canSell, asyncHandler(prescriptionsApiController.lookup));

routeBuilder.apiResource("/products", productsApiController, {
  include: ["index"],
  middleware: [canSell],
});

export default router;
