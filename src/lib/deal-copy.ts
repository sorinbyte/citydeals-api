/*
  Turns a structured offer into the two sentences every client prints.

  ⚠️ This is the ONLY place offer copy is written. It exists because it used to be written sixty
  times, by hand, in a form: the catalogue ended up with "se taxează cel mai scump", "cel mai ieftin
  nu se taxează" and "se taxează una singură" all describing the identical 1+1 rule. Members reading
  three phrasings of one offer can't tell whether they're three different offers.

  The output goes into deals.title / deals.condition, which the mobile app and the marketing site
  already read verbatim. Composing on WRITE rather than on read keeps that contract untouched — no
  client learned anything new — at the cost of the wording being frozen per row. Recomposing every
  row is one UPDATE away, and the day EN lands this moves to read-time.

  TODO(i18n): RO is the source locale. When EN arrives, this function takes a locale and the callers
  recompose rather than reading stored prose.
*/

export type DealCopyInput =
  | { type: "one_plus_one"; itemLabel: string }
  | {
      type: "free_item";
      itemLabel: string;
      /* Null means nothing has to be bought — a free consultation is a real offer. */
      requiredItem: string | null;
      requiredGender: "m" | "f" | null;
    }
  | {
      type: "percentage";
      percentOff: number;
      /* Null = the whole bill. Otherwise a menu section's title. */
      scopeLabel: string | null;
      /* What "everything" is called at THIS venue — see wholeScopeNoun. */
      wholeScopeNoun: string;
    };

export type DealCopy = { title: string; condition: string };

/*
  What "all of it" is called, which depends on what the venue sells.

  A restaurant has a meniu, a barber has servicii, and a cinema has neither — it has a bill. Derived
  from menu_kind rather than asked, because the venue already answered this when its price list was
  set up and asking twice is how the two end up disagreeing.
*/
export function wholeScopeNoun(menuKind: "menu" | "services" | null): string {
  switch (menuKind) {
    case "menu":
      return "tot meniul";
    case "services":
      return "toate serviciile";
    default:
      return "toată nota";
  }
}

/* "unui" / "unei". Neuter nouns take the masculine article in the singular, so two cases cover
   Romanian's three genders for this one job. */
const indefiniteArticle = (gender: "m" | "f"): string => (gender === "f" ? "unei" : "unui");

/* Sentence-cases a noun the owner typed lowercase ("felul principal" → "Felul principal") without
   touching the rest, so "o cafea" doesn't become "O Cafea". */
function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function composeDealCopy(input: DealCopyInput): DealCopy {
  switch (input.type) {
    case "one_plus_one":
      return {
        title: `1+1 la ${input.itemLabel}`,
        /*
          Fixed, and not editable anywhere. This IS the 1+1 rule — the second item is free and it's
          the cheaper of the two — so letting a venue restate it in its own words only ever produced
          a worse version of the same sentence, or a subtly different promise.
        */
        condition: "Produsul cu valoarea mai mică este gratuit.",
      };

    case "free_item":
      return {
        /*
          "gratis", not "gratuit". It's invariable in Romanian, so it agrees with anything —
          "cafea gratis" and "croissant gratis" are both correct, where "gratuit/gratuită" would
          need the free item's gender too and give us a second way to get grammar wrong.
        */
        title: `${capitalise(input.itemLabel)} gratis`,
        condition:
          input.requiredItem && input.requiredGender
            ? `La achiziția ${indefiniteArticle(input.requiredGender)} ${input.requiredItem}.`
            : "Fără altă comandă.",
      };

    case "percentage": {
      const scope = input.scopeLabel ?? input.wholeScopeNoun;
      return {
        /* The minus is U+2212, not a hyphen — it's a real minus sign and lines up in a column of
           numbers, which a hyphen doesn't. */
        title: `−${input.percentOff}% la ${scope}`,
        condition: input.scopeLabel
          ? `Se aplică doar la ${input.scopeLabel}.`
          : `Se aplică la ${input.wholeScopeNoun}, fără alte condiții.`,
      };
    }
  }
}
