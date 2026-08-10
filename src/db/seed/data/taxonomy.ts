/*
  The category taxonomy.

  ⚠️ The two clients currently disagree. The mobile app has four top-level categories; the
  marketing site has six (it splits `cafenele` out of restaurants and `sport` out of
  entertainment). This file is the tiebreaker — the DB is the source of truth and the clients
  follow it, not the other way round.

  Four wins for now because it's what the actual venue data is keyed on and what the asset folders
  are organised by. Splitting later is a data change plus a re-tag, not a migration. Worth an
  explicit decision before launch though — it changes the filter row on both clients.
*/
export const categorySeed = [
  {
    key: "restaurante",
    labelRo: "Restaurante",
    imagePath: "categories/food-drink.webp",
    sortOrder: 1,
  },
  {
    key: "sanatate-frumusete",
    labelRo: "Sănătate & Frumusețe",
    imagePath: "categories/health-beauty.webp",
    sortOrder: 2,
  },
  {
    key: "divertisment",
    labelRo: "Divertisment",
    imagePath: "categories/entertainment.webp",
    sortOrder: 3,
  },
  {
    key: "retail-servicii",
    labelRo: "Retail & Servicii",
    imagePath: "categories/retail-services.webp",
    sortOrder: 4,
  },
] as const;

/*
  Only two categories have subcategories so far. Deliberately trimmed to what the venues below
  actually cover — a filter chip that always lands on an empty list reads as a broken app.
*/
export const subcategorySeed = [
  { key: "italian", categoryKey: "restaurante", labelRo: "Italian", emoji: "🍝", sortOrder: 1 },
  { key: "sushi", categoryKey: "restaurante", labelRo: "Sushi", emoji: "🍣", sortOrder: 2 },
  { key: "mexican", categoryKey: "restaurante", labelRo: "Mexican", emoji: "🌮", sortOrder: 3 },
  { key: "indian", categoryKey: "restaurante", labelRo: "Indian", emoji: "🍛", sortOrder: 4 },
  { key: "mic-dejun", categoryKey: "restaurante", labelRo: "Mic dejun", emoji: "🍳", sortOrder: 5 },
  { key: "pizza", categoryKey: "restaurante", labelRo: "Pizza", emoji: "🍕", sortOrder: 6 },
  { key: "deserturi", categoryKey: "restaurante", labelRo: "Deserturi", emoji: "🍰", sortOrder: 7 },
  { key: "brutarie", categoryKey: "restaurante", labelRo: "Brutărie", emoji: "🥐", sortOrder: 8 },
  {
    key: "frizerii",
    categoryKey: "sanatate-frumusete",
    labelRo: "Frizerii",
    emoji: "💈",
    sortOrder: 1,
  },
  {
    key: "spa-masaj",
    categoryKey: "sanatate-frumusete",
    labelRo: "Spa & Masaj",
    emoji: "🧖",
    sortOrder: 2,
  },
  // the catch-all for hair, nails and skin treatments
  {
    key: "beauty",
    categoryKey: "sanatate-frumusete",
    labelRo: "Beauty",
    emoji: "💅",
    sortOrder: 3,
  },
] as const;

/*
  Plausible opening hours per category, since the placeholder data only ever carried a static
  "isOpen" boolean and that isn't a thing you can store. 1 = Monday … 7 = Sunday (ISO-8601).

  These are invented. Real hours arrive with real partners at onboarding.
*/
export const hoursByCategory: Record<
  string,
  { weekdays: number[]; opens: string; closes: string }[]
> = {
  restaurante: [
    { weekdays: [1, 2, 3, 4], opens: "10:00", closes: "23:00" },
    { weekdays: [5, 6], opens: "10:00", closes: "01:00" },
    { weekdays: [7], opens: "11:00", closes: "22:00" },
  ],
  "sanatate-frumusete": [
    { weekdays: [1, 2, 3, 4, 5], opens: "09:00", closes: "20:00" },
    { weekdays: [6], opens: "09:00", closes: "16:00" },
  ],
  divertisment: [
    { weekdays: [1, 2, 3, 4], opens: "12:00", closes: "23:00" },
    { weekdays: [5, 6], opens: "12:00", closes: "02:00" },
    { weekdays: [7], opens: "12:00", closes: "22:00" },
  ],
  "retail-servicii": [
    { weekdays: [1, 2, 3, 4, 5], opens: "10:00", closes: "20:00" },
    { weekdays: [6], opens: "10:00", closes: "18:00" },
  ],
};
