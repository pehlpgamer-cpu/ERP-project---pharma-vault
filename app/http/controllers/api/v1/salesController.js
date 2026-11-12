import * as z from "zod";
import { createSale } from "../../../../services/sales/checkout.js";
import {
  getSale,
  getSummary,
  listSales,
  loadSaleDetail,
} from "../../../../services/sales/salesQuery.js";
import { isUuid } from "../../../../services/support/ids.js";
import { HttpError, ValidationError } from "../../../errors.js";
import { checkoutRequest } from "../../../requests/sale/checkoutRequest.js";
import { listSalesRequest, summaryRequest } from "../../../requests/sale/listSalesRequest.js";
import { saleDetailResource, saleListResource } from "../../../resources/saleResource.js";
import { paginate } from "../../../support/pagination.js";
import { requestMeta } from "../../../support/requestMeta.js";

export default {
  index: async (req, res) => {
    const filters = listSalesRequest(req.query);
    const { rows, total } = await listSales(filters, req.user);
    const { meta, links } = paginate({
      page: filters.page,
      perPage: filters.perPage,
      total,
      path: `${req.baseUrl}${req.path}`,
      query: req.query,
    });

    return res.json({ data: rows.map(saleListResource), meta, links });
  },

  show: async (req, res) => {
    // A malformed id cannot exist: answer exactly like an unknown or out-of-scope one.
    const sale = z.uuid().safeParse(req.params.id).success
      ? await getSale(req.params.id, req.user)
      : null;

    if (sale === null) {
      throw new HttpError(404, "not_found", "Sale not found");
    }

    return res.json({ data: saleDetailResource(sale) });
  },

  summary: async (req, res) => {
    const summary = await getSummary(summaryRequest(req.query), req.user);

    return res.json({ data: summary });
  },

  // Checkout. JSON only plus an Idempotency-Key: a cross-site HTML form can send neither.
  store: async (req, res) => {
    if (!req.is("application/json")) {
      throw new ValidationError([
        { path: "Content-Type", message: "Send the sale as application/json" },
      ]);
    }

    const key = req.get("Idempotency-Key");

    if (!isUuid(key)) {
      throw new ValidationError([
        { path: "Idempotency-Key", message: "Send an Idempotency-Key header holding a UUID" },
      ]);
    }

    const input = checkoutRequest(req.body);
    const { saleId, replayed } = await createSale(req.user, input, key.toLowerCase(), {
      meta: requestMeta(req),
    });
    const detail = await loadSaleDetail(saleId);

    return res.status(replayed ? 200 : 201).json({ data: saleDetailResource(detail) });
  },
};
