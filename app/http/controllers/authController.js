import { db } from "../../../database/client.js";
import { recordAudit } from "../../services/audit/auditLog.js";
import { verifyPassword } from "../../services/auth/passwords.js";
import { createUser, findUserByEmail } from "../../services/auth/users.js";
import { ValidationError } from "../errors.js";
import { loginRequest } from "../requests/auth/loginRequest.js";
import { registerRequest } from "../requests/auth/registerRequest.js";
import { requestMeta } from "../support/requestMeta.js";
import { isSafeReturnTo } from "../support/returnTo.js";
import { destroySession, regenerateSession, saveSession } from "../support/session.js";

const LOGIN_FAILURE = "Invalid email or password";
const REGISTER_FAILURE =
  "Could not create the account. Use a valid email, a name of at least 2 characters and a password of at least 14 characters.";

export default {
  loginPage: (_req, res) => {
    return res.render("auth/login", { pageTitle: "Login" });
  },

  registerPage: (_req, res) => {
    return res.render("auth/register", { pageTitle: "Register" });
  },

  forgotPasswordPage: (_req, res) => {
    return res.render("auth/forgotpassword", { pageTitle: "Forgot Password" });
  },

  // Replaced by dashboardController in the shell task.
  dashboardPage: (_req, res) => {
    return res.render("dashboard", { pageTitle: "Dashboard" });
  },

  login: async (req, res) => {
    let input;

    try {
      input = loginRequest(req.body);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      req.flash("error_msg", LOGIN_FAILURE);

      return res.redirect("/login-page");
    }

    const meta = requestMeta(req);
    const user = await findUserByEmail(input.email);
    const usable = user?.isActive ? user : null;
    // Always verify, even for an unknown or inactive account, so timing reveals nothing.
    const passwordMatches = await verifyPassword(usable?.password ?? null, input.password);

    if (!usable || !passwordMatches) {
      await recordAudit(db, {
        userId: user?.id ?? null,
        branchId: user?.branchId ?? null,
        action: "LOGIN_FAILED",
        entityType: "user",
        entityId: user?.id ?? null,
        newValues: { email: input.email },
        ...meta,
      });
      req.flash("error_msg", LOGIN_FAILURE);

      return res.redirect("/login-page");
    }

    const returnTo = req.session.returnTo;

    await regenerateSession(req);
    req.session.userId = usable.id;
    await recordAudit(db, {
      userId: usable.id,
      branchId: usable.branchId,
      action: "LOGIN_SUCCESS",
      entityType: "user",
      entityId: usable.id,
      ...meta,
    });
    await saveSession(req);

    return res.redirect(isSafeReturnTo(returnTo) ? returnTo : "/dashboard-page");
  },

  register: async (req, res) => {
    let input;

    try {
      input = registerRequest(req.body);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }

      req.flash("error_msg", REGISTER_FAILURE);

      return res.redirect("/register-page");
    }

    const created = await createUser(input);

    if (created === null) {
      // Same message as a validation failure, so the form never reveals which emails exist.
      req.flash("error_msg", REGISTER_FAILURE);

      return res.redirect("/register-page");
    }

    await recordAudit(db, {
      userId: created.id,
      action: "USER_REGISTERED",
      entityType: "user",
      entityId: created.id,
      newValues: { email: input.email },
      ...requestMeta(req),
    });
    req.flash("success_msg", "Account created. Ask an administrator to give you access.");

    return res.redirect("/login-page");
  },

  logout: async (req, res) => {
    if (req.user) {
      await recordAudit(db, {
        userId: req.user.id,
        branchId: req.user.branchId,
        action: "LOGOUT",
        entityType: "user",
        entityId: req.user.id,
        ...requestMeta(req),
      });
    }

    await destroySession(req);
    res.clearCookie("pv.sid");

    return res.redirect("/login-page");
  },
};
