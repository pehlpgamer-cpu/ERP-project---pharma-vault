import currency from "../../../views/helpers/currency.js";
import {
  closeSession,
  getOpenSession,
  listOpenableRegisters,
  openSession,
  sessionSummary,
  varianceThreshold,
} from "../../services/register/registerSessions.js";
import { cmp } from "../../services/support/decimal.js";
import { HttpError, ValidationError } from "../errors.js";
import { requestMeta } from "../support/requestMeta.js";

const PAGE = "/cash-register-page";

function reasonOf(error) {
  if (error instanceof ValidationError) {
    return error.details
      .map((detail) => {
        return detail.message;
      })
      .join(" ");
  }

  return error.message;
}

// An expected refusal (a 4xx) goes back to the page as a message; anything else is a real error.
async function flashOutcome(req, res, action) {
  try {
    req.flash("success_msg", await action());
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) {
      throw error;
    }

    req.flash("error_msg", reasonOf(error));
  }

  return res.redirect(PAGE);
}

function closeMessage({ status, expectedCash, actualCash, variance }) {
  const counts = `Register closed. Expected ${currency(expectedCash)}, counted ${currency(actualCash)}`;

  if (cmp(variance, "0") === 0) {
    return `${counts}: no difference.`;
  }

  const side = cmp(variance, "0") < 0 ? "short" : "over";
  const difference = `${currency(variance.replace("-", ""))} ${side}`;
  const followUp = status === "RECONCILIATION_REQUIRED" ? " A manager must reconcile it." : "";

  return `${counts}: ${difference}.${followUp}`;
}

export default {
  index: async (req, res) => {
    const session = await getOpenSession(req.user.id);

    return res.render("cash-register/index", {
      pageTitle: "Cash register",
      layout: "authenticated",
      session,
      summary: session ? await sessionSummary(session.id) : null,
      registers: session ? [] : await listOpenableRegisters(req.user.branchId),
      threshold: varianceThreshold(),
    });
  },

  open: (req, res) => {
    return flashOutcome(req, res, async () => {
      await openSession({
        user: req.user,
        registerId: req.body.registerId,
        openingCash: req.body.openingCash,
        meta: requestMeta(req),
      });

      return "Register opened";
    });
  },

  close: (req, res) => {
    return flashOutcome(req, res, async () => {
      const session = await getOpenSession(req.user.id);

      if (session === null) {
        throw new HttpError(409, "register_closed", "You have no open register to close");
      }

      return closeMessage(
        await closeSession({
          user: req.user,
          sessionId: session.id,
          countedCash: req.body.countedCash,
          note: req.body.note,
          meta: requestMeta(req),
        }),
      );
    });
  },
};
