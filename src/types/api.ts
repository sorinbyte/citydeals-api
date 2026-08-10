/*
  The wire format. THIS IS THE CONTRACT — three repos read it, and a rename here breaks two of them
  silently at runtime. Additive changes are safe; renames and removals are not.

  Rules these shapes exist to enforce:

  - Image fields are COMPLETE URLs. Clients never build one, never learn the asset domain.
  - `isOpen` is decided here. The hours TABLE still doesn't cross the wire — a client gets the
    decided boolean, plus (on detail only) today's windows as text to print. It never gets seven
    days of rows to reason over, and it never works out open/closed for itself.
  - Money is an INTEGER in bani plus a currency code. No floats, no pre-formatted strings — the
    client formats with Intl at the moment of display.
  - No user-facing English. Partner content (names, deal titles, conditions) is Romanian because
    the partner wrote it; anything WE word is a code the client translates.
*/

export type DealType = "one_plus_one" | "free_item" | "percentage";

/*
  How a venue list is ordered. A REQUEST value rather than a response one, but it lives here
  because it's part of the contract just the same — clients hardcode these strings.

  Note what's absent: proximity. Sorting by distance needs coordinates, so it's /venues/near, not
  a sort mode here. Alphabetical uses Romanian collation server-side, which is not the same answer
  a byte-order sort gives — see the ordering map in services/venues.ts.
*/
export type VenueSort = "rating" | "az" | "za";

export type Deal = {
  id: string;
  type: DealType;
  title: string;
  /* The catch, in the partner's words. Display only — never parsed, never matched on. */
  condition: string;
  /* Set only when type is "percentage", so clients never scrape a number out of the title. */
  percentOff: number | null;
  /* Minor units (bani). Integer. Display it, never do arithmetic with it. */
  avgSavingMinor: number;
  currency: string;
  refreshDays: number;
  people: number;
};

export type MenuItem = {
  name: string;
  /* The VENUE'S OWN price, undiscounted. The discount happens at the till. */
  priceMinor: number;
  currency: string;
};

export type MenuSection = {
  title: string;
  items: MenuItem[];
};

export type Menu = {
  /* A code — "menu" or "services". The client owns the words "Meniu" / "Servicii". */
  kind: "menu" | "services";
  sections: MenuSection[];
};

/* What a list row needs, and nothing more — lists are the most-fetched thing in the product. */
export type VenueSummary = {
  id: string;
  slug: string;
  name: string;
  categoryKey: string;
  area: string;
  rating: number | null;
  ratingCount: number;
  tags: string[];
  isNew: boolean;
  isOpen: boolean;
  /* "HH:MM" when closed, null when open or when the venue has no hours on file. */
  opensAt: string | null;
  /* Full URL, first photo. Null if the venue has none. */
  image: string | null;
  /*
    The deals worth putting on a card, in the order they should be shown. The server picks and
    orders them; the client doesn't choose and doesn't re-sort.

    A list because venues genuinely run several at once — the barber shop has "-25% la tuns + barbă"
    AND "a cincea tunsoare gratuită", and sending only the first made every card look like a
    one-trick venue. Empty rather than null when nothing is active, so a client can map over it
    without a null check first.

    Capped server-side — see TOP_DEALS_PER_CARD in services/venues.ts. A partner with a dozen active
    offers must not be able to stretch a card off the screen, and how many fit is one product call
    rather than something each surface re-decides.
  */
  topDeals: Array<Pick<Deal, "type" | "title" | "percentOff">>;
};

/*
  One stretch of a day the venue is open, as local wall-clock "HH:MM". A closing time at or before
  the opening time means it runs past midnight — 12:00→02:00 is a normal Friday here.

  Display only, and deliberately not enough to compute anything with: one day's windows, no
  weekday, no date. Whether the place is open right now is `isOpen`, decided server-side.
*/
export type OpeningWindow = {
  opensAt: string;
  closesAt: string;
};

export type VenueDetail = VenueSummary & {
  address: string;
  /*
    Today's opening windows in Europe/Bucharest, in order. Usually one; more than one when a venue
    shuts between lunch and dinner. Empty when it isn't open at all today — which is not the same
    as having no hours on file, and `opensAt` is what tells those apart.

    ⚠️ "Today" is the calendar day, not the session you're currently inside. At 00:30 on Saturday a
    venue open on Friday's 12:00→02:00 row reads isOpen: true while this shows SATURDAY's hours.
    Correct for "what are today's hours", which is what it's for.
  */
  todayHours: OpeningWindow[];
  phone: string | null;
  /*
    Partner logo, full URL. Null today for every venue — no real logos exist yet — so the client
    needs a fallback rather than a non-optional prop. Detail only, deliberately: only the venue
    hero shows it, and list payloads are the most-fetched thing in the product.
  */
  logo: string | null;
  /* Display only — for a pin and a "take me there" deep link. Distance is never client-side. */
  location: { lat: number; lng: number };
  photos: string[];
  deals: Deal[];
  menu: Menu | null;
};

/*
  Summary plus where it is and how far away. Metres, computed by PostGIS, rounded.

  `location` lives here rather than on VenueSummary on purpose: it's only needed to place a pin,
  and this is the endpoint a map calls. Putting it on the summary would add two floats to every
  row of every list in the product — home, category, search — for one screen's benefit, and the
  summary is deliberately "what a list row needs, and nothing more".

  Still display-only. The distance is ours to compute; a client never measures one.
*/
export type VenueNearby = VenueSummary & {
  distanceMetres: number;
  location: { lat: number; lng: number };
};

export type Paginated<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type Subcategory = {
  key: string;
  label: string;
  emoji: string | null;
  image: string | null;
};

export type Category = {
  key: string;
  label: string;
  image: string | null;
  subcategories: Subcategory[];
};

/* ---------------------------------------------------------------------------------------------
   Admin surface. Nothing below is public — these shapes are only ever served under /v1/admin,
   and no member-facing client reads them.
   ------------------------------------------------------------------------------------------- */

export type PartnerStatus = "draft" | "confirmed";
export type LeadStatus = "new" | "contacted" | "qualified" | "rejected";

/*
  A venue as the admin dashboard reads it: everything the public detail carries, plus the
  operational fields the catalogue must never send.

  ⚠️ The extras are the whole reason this is a separate type. `partner` in particular is the one
  the schema warns about (db/schema/catalogue.ts) — which company runs which venue is not public
  information, and the moment it's on VenueDetail it's on the marketing site's JSON too. Adding a
  field here is safe; adding one to VenueDetail to avoid adding it here is not.

  Also note what admin gets that the public read can't: this is fetched by ID and WITHOUT the
  is_published filter. An unpublished venue is invisible to every client except this one, which is
  exactly when someone needs to look at it.
*/
export type AdminVenue = VenueDetail & {
  isPublished: boolean;
  /* Null is a real state, not missing data — venues get created before the company behind them
     exists, and all 30 seeded ones have no partner at all. */
  partner: { id: string; companyName: string } | null;
  createdAt: string;
  updatedAt: string;
};

/*
  One of a partner's locations, as the admin partner page lists them.

  ⚠️ NOT VenueSummary, and not interchangeable with it. That one is the public catalogue shape the
  mobile app and the marketing site read; this one is admin-only and deliberately carries
  operational fields (is_published, created_at) the catalogue has no business sending. Keeping them
  as two types is what stops an admin-only column drifting into a public response — see the warning
  on venues.partner_id in db/schema/catalogue.ts.
*/
export type PartnerVenue = {
  id: string;
  slug: string;
  name: string;
  categoryKey: string;
  /* Neighbourhood. Bucharest-first, so there's no city to send alongside it. */
  area: string;
  /* Whether it's live in the app at all. NOT open/closed — that's worked out from opening_hours
     at query time and changes by the minute. */
  isPublished: boolean;
  createdAt: string;
};

/*
  A partner COMPANY, with the locations it runs.

  `venues` is always a list — a partner with several locations is the normal case, not the edge
  one, and every screen that assumes a single venue has to be rewritten later.
*/
export type Partner = {
  id: string;
  companyName: string;
  /* Digits only, no "RO" prefix. Normalised before it's stored; see services/partners.ts. */
  cui: string;
  status: PartnerStatus;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  venues: PartnerVenue[];
  createdAt: string;
};

export type PartnerLead = {
  id: string;
  venueName: string;
  contactName: string;
  /* A category key, or the literal "altceva". Not constrained to the taxonomy — the marketing
     form deliberately lets someone say "nothing on your list fits us". */
  category: string;
  phone: string;
  email: string;
  /* What the lead wrote. Distinct from `notes`, which is what WE write while working it. */
  message: string | null;
  notes: string | null;
  status: LeadStatus;
  /* Set once a lead becomes a company. Null for everything that hasn't converted. */
  convertedPartnerId: string | null;
  createdAt: string;
};

/*
  Errors carry a stable machine-readable code; the client owns the sentence. Renaming a code is a
  breaking change in three repos, same as renaming a field.
*/
export type ApiError = {
  error: {
    code:
      | "VENUE_NOT_FOUND"
      | "NOT_FOUND"
      | "INVALID_QUERY"
      | "INVALID_BODY"
      /* A path param that isn't a uuid. Separate from INVALID_BODY so the client can tell a bad
         link apart from a bad form — they need different words. */
      | "INVALID_ID"
      | "INTERNAL"
      /* Admin write routes. UNAUTHORIZED is the shared-secret gate, not a real session. */
      | "UNAUTHORIZED"
      | "CUI_TAKEN"
      /* Both unique-index collisions, surfaced as 409s rather than as a generic 500. */
      | "SLUG_TAKEN"
      | "CATEGORY_NOT_FOUND"
      | "PARTNER_NOT_FOUND"
      | "LEAD_NOT_FOUND"
      | "ACTING_ADMIN_MISSING";
    /* Field-level detail for INVALID_QUERY / INVALID_BODY. Developer-facing, never shown to a
       member. */
    details?: unknown;
  };
};
