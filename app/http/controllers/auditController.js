import { listAuditEvents } from "../../services/audit/auditQuery.js";
import { paginate } from "../support/pagination.js";

const str = (value) => {
  return typeof value === "string" ? value.trim() : "";
};

export default {
  index: async (req, res) => {
    const echo = {
      from: str(req.query.from),
      to: str(req.query.to),
      action: str(req.query.action),
      entityType: str(req.query.entityType),
      entityId: str(req.query.entityId),
      q: str(req.query.q),
    };
    const page = Number.parseInt(str(req.query.page) || "1", 10);
    const {
      rows,
      total,
      pageSize,
      entityTypes,
      page: shown,
    } = await listAuditEvents(req.user, {
      ...echo,
      page,
    });
    const query = Object.fromEntries(
      Object.entries(echo).filter(([, value]) => {
        return value !== "";
      }),
    );

    return res.render("audit/index", {
      pageTitle: "Audit trail",
      layout: "authenticated",
      events: rows,
      total,
      filters: echo,
      typeOptions: [
        { value: "", label: "Any entity", selected: echo.entityType === "" },
        ...entityTypes.map((value) => {
          return { value, label: value.replaceAll("_", " "), selected: value === echo.entityType };
        }),
      ],
      pagination: paginate({ page: shown, perPage: pageSize, total, path: "/audit", query }),
    });
  },
};
