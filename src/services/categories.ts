import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { assetUrl } from "@/lib/assets";
import type { Category, Subcategory } from "@/types/api";

type CategoryRow = {
  key: string;
  label_ro: string;
  image_path: string | null;
  subcategories: { key: string; label: string; emoji: string | null; imagePath: string | null }[];
};

/*
  The whole taxonomy in one call. It's small, it changes rarely, and every client needs all of it
  to render a filter row — so paginating or splitting it would just cost round trips.
*/
export async function listCategories(): Promise<Category[]> {
  const result = await db.execute(sql`
    SELECT
      c.key,
      c.label_ro,
      c.image_path,
      COALESCE((SELECT json_agg(json_build_object(
                  'key', s.key, 'label', s.label_ro, 'emoji', s.emoji, 'imagePath', s.image_path
                ) ORDER BY s.sort_order)
                FROM subcategories s WHERE s.category_key = c.key), '[]'::json) AS subcategories
    FROM categories c
    ORDER BY c.sort_order
  `);

  return (result.rows as CategoryRow[]).map((row) => ({
    key: row.key,
    label: row.label_ro,
    image: assetUrl(row.image_path),
    subcategories: row.subcategories.map(
      (s): Subcategory => ({
        key: s.key,
        label: s.label,
        emoji: s.emoji,
        image: assetUrl(s.imagePath),
      }),
    ),
  }));
}
