import { listMovements, MOVEMENT_TYPES } from "../../services/inventory/movementLedger.js";
import { paginate } from "../support/pagination.js";

const str = (value) => {
  return typeof value === "string" ? value.trim() : "";
};

const typeLabel = (value) => {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
};

export default {
  movements: async (req, res) => {
    const echo = {
      from: str(req.query.from),
      to: str(req.query.to),
      type: str(req.query.type),
      q: str(req.query.q),
      branchId: str(req.query.branchId),
    };
    const page = Number.parseInt(str(req.query.page) || "1", 10);
    const result = await listMovements(req.user, { ...echo, page });
    const query = Object.fromEntries(
      Object.entries(echo).filter(([, value]) => {
        return value !== "";
      }),
    );

    return res.render("reports/movements", {
      pageTitle: "Stock movements",
      layout: "authenticated",
      movements: result.rows,
      total: result.total,
      filters: echo,
      allBranches: result.allBranches,
      typeOptions: [
        { value: "", label: "Any type", selected: echo.type === "" },
        ...MOVEMENT_TYPES.map((value) => {
          return { value, label: typeLabel(value), selected: value === echo.type };
        }),
      ],
      pagination: paginate({
        page: result.page,
        perPage: result.pageSize,
        total: result.total,
        path: "/reports/movements",
        query,
      }),
    });
  },
};
