import { timestamp } from "drizzle-orm/mysql-core";

export default {
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
};
