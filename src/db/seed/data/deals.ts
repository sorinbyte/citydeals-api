/*
  Deals, keyed by venue slug. Split out of venues.ts so both files stay readable.

  ⚠️ No `title` and no `condition` here any more. Both are composed at seed time by the same
  lib/deal-copy.ts the API uses, so a seeded catalogue is indistinguishable from one typed into the
  admin form — which is the point. This file used to hold sixty hand-written sentences, and it was
  the clearest evidence of the problem: "se taxează cel mai scump", "cel mai ieftin nu se taxează"
  and "se taxează una singură" all described the same 1+1 rule.

  A few offers changed meaning in the conversion, because the constrained model can't express them:

    · loyalty ("a cincea tunsoare gratuită", "a treia cursă gratuită") — there is no counter in the
      schema, so these were never enforceable anyway; they're now ordinary free-item offers
    · quantity ("3 tacos la preț de 2") — same reason
    · scopes that aren't menu sections ("la băuturi", "la livrare", "la meniul vegetarian") — a
      percentage is now either the whole bill or one section, so these became whole-bill

  Placeholder content until real partners sign. Savings are in bani, integers, never floats.
*/

/*
  Spelled out rather than reusing DealCopyInput, because that union's percentage arm also carries
  `wholeScopeNoun` — which depends on the venue's menu_kind and so isn't known until insert time.
*/
export type DealSeedRow = {
  offer:
    | { type: "one_plus_one"; itemLabel: string }
    | {
        type: "free_item";
        itemLabel: string;
        requiredItem: string | null;
        requiredGender: "m" | "f" | null;
      }
    | { type: "percentage"; percentOff: number; scopeLabel: string | null };
  avgSavingMinor: number;
  refreshDays: number;
  people: 1 | 2;
};

/* 1+1 is two people by definition — the helper enforces it so nobody hand-writes people: 1. */
const bogo = (itemLabel: string, avgSavingMinor: number, refreshDays: number): DealSeedRow => ({
  offer: { type: "one_plus_one", itemLabel },
  avgSavingMinor,
  refreshDays,
  people: 2,
});

/*
  `required` is the noun that has to be bought, with its grammatical gender, or null for an offer
  that needs no purchase at all.

  ⚠️ Feminine nouns go in the GENITIVE, because that's the form the composed sentence needs:
  "la achiziția unei cafele", not "unei cafea". Masculine and neuter don't change.
*/
const free = (
  itemLabel: string,
  required: readonly [string, "m" | "f"] | null,
  avgSavingMinor: number,
  refreshDays: number,
  people: 1 | 2 = 1,
): DealSeedRow => ({
  offer: {
    type: "free_item",
    itemLabel,
    requiredItem: required?.[0] ?? null,
    requiredGender: required?.[1] ?? null,
  },
  avgSavingMinor,
  refreshDays,
  people,
});

/* `scope` is a menu section title, or null for the whole bill. Only titles that actually exist on
   that venue's menu — a scope pointing at a section the venue doesn't have would read as a promise
   nobody can find. */
const pct = (
  percentOff: number,
  scope: string | null,
  avgSavingMinor: number,
  refreshDays: number,
  people: 1 | 2 = 1,
): DealSeedRow => ({
  offer: { type: "percentage", percentOff, scopeLabel: scope },
  avgSavingMinor,
  refreshDays,
  people,
});

export const dealsByVenueSlug: Record<string, DealSeedRow[]> = {
  // ─── Restaurante ──────────────────────────────────────────────────────────────────────────
  "trattoria-bucureseana": [
    bogo("felul principal", 5500, 90),
    free("desert", ["fel principal", "m"], 2200, 30),
    pct(20, null, 1500, 30),
  ],
  "sushi-master": [
    bogo("platoul de sushi", 9500, 90),
    free("supă miso", ["platou", "m"], 1800, 30),
  ],
  "el-torito": [
    bogo("porția de tacos", 3500, 30),
    free("guacamole", ["fel principal", "m"], 1900, 30),
  ],
  "taj-palace": [pct(20, null, 4200, 30), free("naan", ["curry", "m"], 1200, 7)],
  "cafeneaua-veche": [
    bogo("cafeaua de specialitate", 1700, 7),
    // "Mic dejun" is a real section on this venue's menu
    pct(15, "Mic dejun", 2400, 30),
  ],
  "osteria-del-corso": [
    pct(25, "Paste", 3800, 30),
    free("tiramisu", ["fel principal", "m"], 2500, 30, 2),
  ],
  "kaido-sushi": [bogo("bolul de ramen", 4800, 90), pct(10, null, 2600, 30)],
  // was "3 tacos la preț de 2" — a quantity offer the schema can't enforce
  "taqueria-central": [free("porție de nachos", ["fel principal", "m"], 1600, 30)],
  "namaste-bucuresti": [pct(20, null, 3300, 30), free("lassi", ["curry", "m"], 1400, 7)],
  "morning-glory": [bogo("meniul de brunch", 6500, 90)],
  "pasta-e-basta": [pct(15, null, 3100, 30), free("focaccia", ["fel principal", "m"], 1500, 30)],
  "sakura-bistro": [bogo("bolul poke", 4400, 90), pct(10, null, 1200, 7)],
  "casa-mexicana": [pct(20, "Platouri", 3600, 30), free("nachos", ["cocktail", "m"], 2100, 30, 2)],
  "curry-house": [bogo("felul principal", 4600, 90)],
  "brunch-and-co": [pct(15, "Mic dejun", 2300, 30), free("cafea", ["croissant", "m"], 1300, 7)],

  // ─── Sănătate & Frumusețe ─────────────────────────────────────────────────────────────────
  "barber-shop-centrul-vechi": [
    pct(25, "Tuns & barbă", 3000, 30),
    // was "a cincea tunsoare gratuită" — loyalty, and there is no counter in the schema
    free("aranjatul bărbii", ["tunsori", "f"], 8000, 90),
  ],
  "frizeria-clasica": [bogo("bărbieritul tradițional", 6000, 90)],
  "glow-beauty-bar": [
    pct(25, "Ten", 9000, 90),
    // the case that needs no purchase at all
    free("consultație", null, 5000, 90),
  ],
  "spa-elysee": [
    pct(20, "Pachete", 12000, 90),
    free("accesul la saună", ["tratament", "m"], 6000, 30),
  ],
  "studio-relax-masaj": [bogo("masajul de 60 de minute", 15000, 90)],

  // ─── Divertisment ─────────────────────────────────────────────────────────────────────────
  // No price lists at all down here, so every percentage is the whole bill.
  "club-biliard-8-ball": [
    free("oră de joc", ["ore de joc", "f"], 4000, 30, 2),
    pct(15, null, 1800, 30),
  ],
  "cinema-city": [
    bogo("biletul de film", 3500, 30),
    free("popcorn mare", ["bilet", "m"], 2500, 30, 2),
    pct(10, null, 1000, 7),
  ],
  "karting-arena": [
    pct(20, null, 3000, 30),
    // was "a treia cursă gratuită" — loyalty again
    free("cursă de încălzire", ["curse", "f"], 6000, 90),
  ],
  "padel-club-bucuresti": [pct(25, null, 5000, 30)],
  "tenis-club-herastrau": [
    bogo("ora de teren", 7000, 90),
    free("închirierea rachetei", ["rezervări", "f"], 2000, 30),
  ],

  // ─── Retail & Servicii ────────────────────────────────────────────────────────────────────
  "boutique-central": [pct(10, null, 8000, 90), free("transportul", ["comenzi", "f"], 2000, 30)],
  "casa-si-stil": [pct(15, null, 6000, 90)],
  "floraria-iris": [
    pct(20, null, 4000, 30),
    free("livrarea în București", ["buchet", "m"], 2500, 30),
  ],
  "service-gsm-expres": [
    pct(25, null, 15000, 90),
    // no purchase needed — you bring the phone in and the check is free
    free("diagnosticul", null, 5000, 30),
  ],
  "croitoria-moderna": [pct(15, null, 3000, 30)],
};
