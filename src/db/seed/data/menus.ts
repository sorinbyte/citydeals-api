/*
  Price lists, lifted from the mobile app's src/features/venue/menus.ts.

  Shared per archetype on purpose — three trattorias showing the same pasta list is fine for
  placeholder content and real partners replace all of it at onboarding.

  Prices are the VENUE'S OWN, in bani. The discount is a separate thing entirely (see deals) and
  gets applied at the till.

  `kind` is a code, not a word. "Meniu"/"Servicii" is the client's copy to own.
*/

export type MenuItemSeed = { name: string; priceMinor: number };
export type MenuSectionSeed = { title: string; items: MenuItemSeed[] };
export type MenuSeed = { kind: "menu" | "services"; sections: MenuSectionSeed[] };

// shorthand: name + price in bani
const i = (name: string, priceMinor: number): MenuItemSeed => ({ name, priceMinor });

export const menuArchetypes = {
  italian: {
    kind: "menu",
    sections: [
      {
        title: "Antipasti",
        items: [
          i("Bruschetta cu roșii", 2400),
          i("Burrata cu prosciutto", 4500),
          i("Focaccia cu rozmarin", 1800),
        ],
      },
      {
        title: "Paste",
        items: [
          i("Cacio e pepe", 4800),
          i("Tagliatelle cu ragù", 5400),
          i("Gnocchi cu gorgonzola", 5200),
        ],
      },
      { title: "Pizza", items: [i("Margherita", 3800), i("Diavola", 4600)] },
    ],
  },
  sushi: {
    kind: "menu",
    sections: [
      {
        title: "Nigiri & Sashimi",
        items: [i("Nigiri somon (2 buc)", 2200), i("Sashimi ton roșu (5 buc)", 5800)],
      },
      {
        title: "Maki & Uramaki",
        items: [i("California roll (8 buc)", 4200), i("Spicy tuna roll (8 buc)", 4800)],
      },
      { title: "Feluri calde", items: [i("Ramen shoyu", 5200), i("Gyoza cu pui (5 buc)", 2600)] },
    ],
  },
  mexican: {
    kind: "menu",
    sections: [
      {
        title: "De început",
        items: [i("Guacamole cu totopos", 2800), i("Nachos cu brânză", 2600)],
      },
      {
        title: "Tacos",
        items: [
          i("Tacos al pastor (3 buc)", 3600),
          i("Tacos de carnitas (3 buc)", 3800),
          i("Tacos vegetarieni (3 buc)", 3200),
        ],
      },
      {
        title: "Platouri",
        items: [i("Fajitas de pui", 5600), i("Quesadilla cu brânză", 3400)],
      },
    ],
  },
  indian: {
    kind: "menu",
    sections: [
      {
        title: "Curry",
        items: [i("Butter chicken", 5200), i("Palak paneer", 4400), i("Lamb rogan josh", 5800)],
      },
      { title: "Din tandoor", items: [i("Pui tandoori", 4800), i("Naan cu usturoi", 1200)] },
      { title: "Garnituri", items: [i("Orez basmati", 1000), i("Raita", 900)] },
    ],
  },
  brunch: {
    kind: "menu",
    sections: [
      {
        title: "Mic dejun",
        items: [i("Ouă Benedict", 3400), i("Avocado toast", 3000), i("Clătite cu fructe", 2800)],
      },
      { title: "Cafea", items: [i("Espresso", 900), i("Flat white", 1500), i("Filtru V60", 1800)] },
      { title: "Patiserie", items: [i("Croissant cu unt", 1100), i("Cinnamon roll", 1400)] },
    ],
  },
  barber: {
    kind: "services",
    sections: [
      {
        title: "Tuns & barbă",
        items: [i("Tuns clasic", 6000), i("Tuns + barbă", 9000), i("Aranjat barbă", 4000)],
      },
      {
        title: "Extra",
        items: [i("Bărbierit tradițional cu brici", 5500), i("Spălat & styling", 2500)],
      },
    ],
  },
  spa: {
    kind: "services",
    sections: [
      {
        title: "Masaj",
        items: [
          i("Masaj de relaxare, 60 min", 18000),
          i("Masaj terapeutic, 60 min", 20000),
          i("Masaj cu pietre calde, 90 min", 28000),
        ],
      },
      {
        title: "Pachete",
        items: [i("Acces spa, o zi", 12000), i("Pachet spa pentru două persoane", 32000)],
      },
    ],
  },
  beauty: {
    kind: "services",
    sections: [
      {
        title: "Ten",
        items: [i("Tratament facial complet", 22000), i("Curățare facială", 15000)],
      },
      {
        title: "Unghii",
        items: [i("Manichiură semipermanentă", 12000), i("Pedichiură", 14000)],
      },
      { title: "Păr", items: [i("Tuns & coafat", 9000)] },
    ],
  },
} satisfies Record<string, MenuSeed>;

export type MenuArchetype = keyof typeof menuArchetypes;

/*
  Which venue gets which list. Entertainment and retail are absent on purpose — a cinema has
  nothing to put in one. A croitorie or a phone-repair shop genuinely would, they just don't have
  real prices yet, and inventing them would be inventing partner data rather than placeholder shape.
*/
export const menuByVenueSlug: Record<string, MenuArchetype> = {
  "trattoria-bucureseana": "italian",
  "osteria-del-corso": "italian",
  "pasta-e-basta": "italian",

  "sushi-master": "sushi",
  "kaido-sushi": "sushi",
  "sakura-bistro": "sushi",

  "el-torito": "mexican",
  "taqueria-central": "mexican",
  "casa-mexicana": "mexican",

  "taj-palace": "indian",
  "namaste-bucuresti": "indian",
  "curry-house": "indian",

  "cafeneaua-veche": "brunch",
  "morning-glory": "brunch",
  "brunch-and-co": "brunch",

  "barber-shop-centrul-vechi": "barber",
  "frizeria-clasica": "barber",
  "glow-beauty-bar": "beauty",
  "spa-elysee": "spa",
  "studio-relax-masaj": "spa",
};
