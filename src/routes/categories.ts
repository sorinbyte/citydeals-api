import { Hono } from "hono";

import { listCategories } from "@/services/categories";

export const categoriesRoute = new Hono().get("/", async (c) =>
  c.json({ items: await listCategories() }),
);
