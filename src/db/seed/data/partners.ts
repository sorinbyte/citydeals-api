/*
  Placeholder partner companies, and which of the 30 seeded venues each one runs.

  All of it is invented. The company names, the contacts and the phone numbers are made up, and
  every email is on a `.invalid` domain — reserved by RFC 2606, so none of it can ever be dialled
  or written to by accident. That domain is also how the seed recognises its own rows; see the
  provenance note in ../index.ts.

  The groupings follow the catalogue: the seeded venues come in cuisine triplets (three Italian,
  three Japanese, three Indian…), which is exactly the multi-location case that matters. A partner
  owning several venues is the normal case in this product, not the edge one — every admin screen
  has to handle it, so the fixtures make sure it shows up immediately rather than after onboarding
  a real chain.

  Six venues are deliberately left with NO partner (karting-arena, club-biliard-8-ball, cinema-city,
  casa-si-stil, croitoria-moderna, service-gsm-expres). The "no company behind this venue yet" state
  is real — every venue in the catalogue is in it today — and admin needs to render it.
*/

export type PartnerSeed = {
  companyName: string;
  /*
    Checksum-valid Romanian CUIs, computed with the real key (753217532) rather than typed at
    random. Validation isn't built yet — it belongs in the service layer, not a CHECK constraint —
    but when it lands, fixtures that fail it would send someone hunting a bug that isn't there.

    Stored normalised: digits only, no "RO" prefix. See the column comment in schema/partners.ts.
  */
  cui: string;
  status: "draft" | "confirmed";
  contactName: string;
  contactEmail: string;
  /* E.164, like every other phone in this database. Never prettified. */
  contactPhone: string;
  /* Venue slugs this company runs. The seed resolves them to ids — slugs are stable, ids aren't. */
  venueSlugs: string[];
};

export const partnerSeed: PartnerSeed[] = [
  {
    companyName: "Gruppo Italiano SRL",
    cui: "12345674",
    status: "confirmed",
    contactName: "Luca Rossi",
    contactEmail: "luca@gruppoitaliano.invalid",
    contactPhone: "+40721100201",
    venueSlugs: ["trattoria-bucureseana", "osteria-del-corso", "pasta-e-basta"],
  },
  {
    companyName: "Sakura Group SRL",
    cui: "28459136",
    status: "confirmed",
    contactName: "Andrei Tanaka",
    contactEmail: "andrei@sakuragroup.invalid",
    contactPhone: "+40721100202",
    venueSlugs: ["kaido-sushi", "sushi-master", "sakura-bistro"],
  },
  {
    companyName: "Cantina Mexicana SRL",
    cui: "33917426",
    status: "confirmed",
    contactName: "Elena Márquez",
    contactEmail: "elena@cantinamexicana.invalid",
    contactPhone: "+40721100203",
    venueSlugs: ["casa-mexicana", "el-torito", "taqueria-central"],
  },
  {
    companyName: "Spice Route SRL",
    cui: "41278560",
    status: "confirmed",
    contactName: "Rajesh Nair",
    contactEmail: "rajesh@spiceroute.invalid",
    contactPhone: "+40721100204",
    venueSlugs: ["curry-house", "namaste-bucuresti", "taj-palace"],
  },
  {
    companyName: "Morning Group SRL",
    cui: "56382011",
    status: "confirmed",
    contactName: "Ioana Dobre",
    contactEmail: "ioana@morninggroup.invalid",
    contactPhone: "+40721100205",
    venueSlugs: ["brunch-and-co", "cafeneaua-veche", "morning-glory"],
  },
  {
    companyName: "Elysée Wellness SRL",
    cui: "64720938",
    status: "confirmed",
    contactName: "Ana Blaga",
    contactEmail: "ana@elyseewellness.invalid",
    contactPhone: "+40721100206",
    venueSlugs: ["spa-elysee", "glow-beauty-bar", "studio-relax-masaj"],
  },
  {
    companyName: "Barber Brothers SRL",
    cui: "78153647",
    status: "confirmed",
    contactName: "Mihai Stoica",
    contactEmail: "mihai@barberbrothers.invalid",
    contactPhone: "+40721100207",
    venueSlugs: ["barber-shop-centrul-vechi", "frizeria-clasica"],
  },
  /* Two still in draft — signed nothing yet. The admin Parteneri list needs both states visible,
     and a draft partner that already has venues attached is the realistic shape: you add the
     locations while you're filling the paperwork in. */
  {
    companyName: "Active Sports SRL",
    cui: "82039471",
    status: "draft",
    contactName: "Cristian Gheorghe",
    contactEmail: "cristian@activesports.invalid",
    contactPhone: "+40721100208",
    venueSlugs: ["padel-club-bucuresti", "tenis-club-herastrau"],
  },
  {
    companyName: "Urban Retail SRL",
    cui: "91640283",
    status: "draft",
    contactName: "Diana Luca",
    contactEmail: "diana@urbanretail.invalid",
    contactPhone: "+40721100209",
    venueSlugs: ["boutique-central", "floraria-iris"],
  },
];
