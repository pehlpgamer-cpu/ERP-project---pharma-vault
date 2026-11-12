export const homePage = (req, res) => {
  if (req.user) {
    return res.redirect("/dashboard-page");
  }

  return res.render("home", { pageTitle: "Pharma Vault POS" });
};
