import { lookupDispensable } from "../../../../services/sales/prescriptions.js";
import { ValidationError } from "../../../errors.js";

export default {
  // The sales screen's prescription box: one prescription by its number, when it can be dispensed.
  lookup: async (req, res) => {
    const number = typeof req.query.number === "string" ? req.query.number.trim() : "";

    if (number === "") {
      throw new ValidationError([{ path: "number", message: "Enter the prescription number" }]);
    }

    return res.json({ data: await lookupDispensable(req.user, number) });
  },
};
