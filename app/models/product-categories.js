import * as t from "drizzle-orm/mysql-core";
import timestamps from "./helpers/timestamps.js";
import { uuid, uuidPrimaryKey } from "./helpers/uuid.js";

export const productCategories = t.mysqlTable(
  "product_categories",
  {
    id: uuidPrimaryKey(),
    parentId: uuid("parent_id"),
    name: t.varchar({ length: 150 }).notNull(),
    description: t.text(),
    isActive: t.boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => {
    return [
      t.index("idx_categories_parent").on(table.parentId),
      t
        .foreignKey({
          name: "fk_categories_parent",
          columns: [table.parentId],
          foreignColumns: [table.id],
        })
        .onUpdate("cascade")
        .onDelete("set null"),
    ];
  },
);
