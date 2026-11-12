export default {
  // Placeholder content; the dashboard task replaces it with the sales overview.
  index: (_req, res) => {
    return res.render("dashboard", { pageTitle: "Dashboard", layout: "authenticated" });
  },
};
