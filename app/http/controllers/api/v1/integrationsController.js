import { searchMedicines } from "../../../../services/integrations/medicineSearch.js";
import { productSearchRequest } from "../../../requests/product/productSearchRequest.js";

export default {
  // GET /api/v1/integrations/medicines?q=&limit=  ->  { data: [{ name, genericName, brandNames, status, ... }] }
  medicines: async (req, res) => {
    const { q, limit } = productSearchRequest(req.query);

    return res.json({ data: await searchMedicines({ q, limit }) });
  },
};
