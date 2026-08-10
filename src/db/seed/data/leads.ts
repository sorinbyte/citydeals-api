/*
  Placeholder partner leads — people who filled in the form on /parteneri.

  All invented, every email on a `.invalid` domain (RFC 2606). That domain is not decoration: it's
  how the seed tells its own leads apart from real ones. `POST /partner-leads` doesn't exist yet so
  there are no real leads to confuse them with today, but it's next on the list, and a seed that
  wipes genuine inbound leads because it couldn't tell them apart is a bad afternoon.

  Covers all four statuses, because the Lead-uri tab filters on them and a fixture set that's all
  `new` proves nothing about the screen.

  A lead is NOT an account and grants nothing. Converting one means an admin creating a partner and
  sending an invite — which is what keeps venue verification on our side of the wire.
*/

export type LeadSeed = {
  venueName: string;
  contactName: string;
  /* A category key from the taxonomy, or the literal "altceva" — the form offers both, and the
     column is plain text precisely so "altceva" is representable. */
  category: string;
  phone: string;
  email: string;
  /* What the lead wrote in the form's free-text box. Optional there, so optional here. */
  message?: string;
  /* What WE wrote while working it. Never shown to them. Only makes sense once someone's touched
     the lead, so the `new` ones don't have any. */
  notes?: string;
  status: "new" | "contacted" | "qualified" | "rejected";
  /*
    Set on the one lead that became a company, matched by CUI to ../data/partners.ts.

    Note there is no "converted" status: converted is `qualified` PLUS this pointer. A separate
    status would let a lead be marked converted with nothing to point at, which answers the funnel
    question wrongly and silently.
  */
  convertedPartnerCui?: string;
};

export const leadSeed: LeadSeed[] = [
  {
    venueName: "Trattoria Roma",
    contactName: "Giuseppe Marino",
    category: "restaurante",
    phone: "+40722345678",
    email: "giuseppe@trattoriaroma.invalid",
    message: "Avem două locații în centru și ne-ar interesa un parteneriat.",
    status: "new",
  },
  {
    venueName: "Brew Lab",
    contactName: "Alex Toma",
    category: "restaurante",
    phone: "+40733456789",
    email: "alex@brewlab.invalid",
    status: "new",
  },
  {
    venueName: "Atelier Foto Nord",
    contactName: "Sorina Ilie",
    /* The "nothing on your list fits us" case. Exactly the kind of lead worth hearing about, and
       the reason `category` isn't a foreign key. */
    category: "altceva",
    phone: "+40744111222",
    email: "sorina@atelierfotonord.invalid",
    message: "Facem ședințe foto de familie. Nu m-am regăsit în categoriile din formular.",
    status: "new",
  },
  {
    venueName: "Zen Spa",
    contactName: "Laura Dinu",
    category: "sanatate-frumusete",
    phone: "+40755678901",
    email: "laura@zenspa.invalid",
    message: "Vrem să înțelegem cum funcționează comisionul.",
    notes: "Sunat 5 aug, revine joi cu răspuns de la asociat.",
    status: "contacted",
  },
  {
    venueName: "FitZone",
    contactName: "Cristina Vlad",
    category: "divertisment",
    phone: "+40766789012",
    email: "cristina@fitzone.invalid",
    notes: "Interesată, dar vrea să vadă întâi cifre de trafic. Retrimis materialele.",
    status: "contacted",
  },
  {
    venueName: "Pizza Express",
    contactName: "Mihai Radu",
    category: "restaurante",
    phone: "+40777890123",
    email: "mihai@pizzaexpress.invalid",
    message: "Putem oferi 1+1 la pizza în timpul săptămânii.",
    notes: "Calificat. Trimis contractul, așteptăm semnătura.",
    status: "qualified",
  },
  /* The converted one — qualified, and pointing at the company it became. */
  {
    venueName: "Gruppo Italiano",
    contactName: "Luca Rossi",
    category: "restaurante",
    phone: "+40721100201",
    email: "luca@gruppoitaliano.invalid",
    message: "Trei restaurante italiene în București.",
    notes: "Semnat. Cont creat, invitație trimisă.",
    status: "qualified",
    convertedPartnerCui: "12345674",
  },
  {
    venueName: "Corner Bar",
    contactName: "Dan Pavel",
    category: "restaurante",
    phone: "+40788901234",
    email: "dan@cornerbar.invalid",
    notes: "Prea mic pentru logistica de onboarding. Revenim dacă deschid a doua locație.",
    status: "rejected",
  },
];
