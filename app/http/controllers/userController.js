import { listUsers } from "../../services/auth/users.js";
import notImplemented from "../support/notImplemented.js";

export default {
  index: async (_req, res) => {
    const users = await listUsers();

    return res.render("users", { pageTitle: "Users", layout: "authenticated", users });
  },

  show: notImplemented,
  store: notImplemented,
  update: notImplemented,
  replace: notImplemented,
  destroy: notImplemented,
  create: notImplemented,
  edit: notImplemented,
};
