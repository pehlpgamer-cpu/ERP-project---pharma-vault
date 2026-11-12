import { searchProducts } from "../../../../services/catalog/productLookup.js";
import { productSearchRequest } from "../../../requests/product/productSearchRequest.js";
import { productResource } from "../../../resources/productResource.js";

export default {
  index: async (req, res) => {
    const { q, limit } = productSearchRequest(req.query);
    const items = await searchProducts({ q, limit, branchId: req.user.branchId });

    return res.json({ data: items.map(productResource) });
  },
};
