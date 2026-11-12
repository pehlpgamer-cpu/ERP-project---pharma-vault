import { getOpenSession } from "../../services/register/registerSessions.js";

// Where the browser script finds the API; it reaches the page only through data-config.
const CONFIG = Object.freeze({
  currency: "PHP",
  productsUrl: "/api/v1/products",
  salesUrl: "/api/v1/sales",
});

export default {
  page: async (req, res) => {
    const session = await getOpenSession(req.user.id);

    if (session === null) {
      req.flash("error_msg", "Open a register first");

      return res.redirect("/cash-register-page");
    }

    return res.render("pos/index", {
      pageTitle: "New sale",
      layout: "authenticated",
      session,
      config: CONFIG,
    });
  },
};
