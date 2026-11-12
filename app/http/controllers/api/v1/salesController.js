import * as z from "zod";
import { getSale, getSummary, listSales } from "../../../../services/sales/salesQuery.js";
import { HttpError } from "../../../errors.js";
import { listSalesRequest, summaryRequest } from "../../../requests/sale/listSalesRequest.js";
import { saleDetailResource, saleListResource } from "../../../resources/saleResource.js";
import { paginate } from "../../../support/pagination.js";

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
};
