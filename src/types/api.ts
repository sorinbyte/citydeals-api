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

/*
  One opening window with the day attached — the whole week, flat, for an editor.

  ⚠️ NOT on the public venue shape, and it shouldn't be. Clients are given `isOpen`, `opensAt` and
  `todayHours` precisely so nobody reimplements the open/closed decision on a device with a wrong
  clock; handing them the raw table would invite exactly that.

  `weekday` is ISO-8601: 1 = Monday … 7 = Sunday, matching Postgres' EXTRACT(ISODOW) and the
  queries in lib/hours.ts.

  ⚠️ `closesAt` <= `opensAt` is LEGAL and means the window runs past midnight — a restaurant open
  10:00–01:00 is one row, Friday, closing Saturday morning. Anything validating "close must be
  after open" breaks every venue in the catalogue that shuts after midnight.
*/
export type VenueHoursWindow = {
  weekday: number;
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
/*
  A deal as the admin editor needs it, which is strictly more than a member gets.

  Two extras and both are load-bearing. `isActive` because the public projection filters deactivated
  deals out entirely — without this an admin cannot see, let alone reactivate, an offer they just
  switched off. `sortOrder` because it decides which three deals a card shows (TOP_DEALS_PER_CARD in
  services/venues.ts), so it's a real editorial lever rather than an implementation detail.
*/
export type DealGender = "m" | "f";

/*
  A row in the admin venues table.

  ⚠️ NOT VenueSummary. That one is the public catalogue shape — built for a card, so it carries a
  photo, a rating, opening state and the top three deals, none of which a triage table wants. This
  carries what you scan a list for: who owns it, how many offers it's running, and whether it's
  live. Keeping them separate is what stops `partner` drifting into a public response.
*/
export type AdminVenueListItem = {
  id: string;
  slug: string;
  name: string;
  categoryKey: string;
  area: string;
  /* Null is a real state — venues exist before the company behind them does. */
  partner: { id: string; companyName: string } | null;
  /*
    ACTIVE offers only. A deactivated one shows nowhere in the app, so counting it here would
    overstate what the venue is actually running — which is the number this column exists to
    answer.
  */
  activeDealCount: number;
  isPublished: boolean;
};

/* What the admin list can be ordered by. Codes, not column names — the service decides how each
   one maps to SQL, and `category` deliberately isn't alphabetical. */
export type AdminVenueSort = "name" | "category" | "area" | "partner" | "offers" | "status";

/*
  One of the venues a partner was granted, for the picker on their own dashboard.

  Deliberately NOT AdminVenueListItem, even though it looks similar. That one carries `partner`,
  because the whole point of the admin table is seeing which company a venue belongs to; here the
  answer is always "yours" and the column would be the same word on every row.

  It carries a photo where the admin table doesn't, for the opposite reason: admin triages thirty
  venues in a dense table and a thumbnail per row is noise, while a partner is choosing between
  three places they recognise on sight.

  ⚠️ No sort, no filters, no paging anywhere near this. A venue_owner has a handful of venues —
  every one of those controls would be machinery with nothing to do.
*/
export type PartnerVenueListItem = {
  id: string;
  slug: string;
  name: string;
  categoryKey: string;
  area: string;
  /* Full URL of the first photo, or null. Same "position is primary" rule as everywhere else. */
  image: string | null;
  /* ACTIVE offers only — what the venue is actually running right now, which is the number a
     partner is checking when they glance at this list. */
  activeDealCount: number;
  /*
    Read-only on this dashboard. Shown because a partner needs to know whether members can see
    them at all; not editable, because going live is a commercial decision.
  */
  isPublished: boolean;
};

/*
  Where a member is in their trial. Derived in SQL from two nullable timestamps, so no client works
  it out from dates and no two clients disagree about what "expired" means.

    none    — verified their phone and never started a trial
    active  — trial_ends_at is still in the future
    expired — it isn't

  ⚠️ There is deliberately no "subscribed" or "cancelled" here. Subscriptions aren't built: the
  members table carries OUR trial dates and nothing a payment provider owns. When that lands this
  becomes a bigger union, and everything reading it will fail to compile — which is the point.
*/
export type MemberTrialState = "none" | "active" | "expired";

/*
  A member, as the admin dashboard reads them.

  ⚠️ Real people. This is the only admin surface showing a verified personal phone number, and it's
  shown in full on purpose — the support case is someone writing in and being looked up, which a
  masked number can't serve. Everything here is need-to-know for that job and nothing more.
*/
export type AdminMember = {
  id: string;
  /* Optional — we ask at signup and they can skip. A support conversation works off the phone. */
  name: string | null;
  /* E.164, never prettified. Storing a formatted number is storing one a lookup can't match. */
  phone: string;
  phoneVerifiedAt: string;
  trialState: MemberTrialState;
  /* Null unless a trial was started. `trialState` is what to branch on; this is for showing when. */
  trialEndsAt: string | null;
  /* Null means they verified and never came back — a signal, not missing data. */
  lastSeenAt: string | null;
  createdAt: string;
};

export type AdminMemberSort = "name" | "phone" | "trial" | "lastSeen" | "joined";

export type AdminDeal = Deal & {
  isActive: boolean;
  sortOrder: number;
  /*
    The structured offer behind `title` and `condition`.

    Admin-only because no client needs it: they print the composed sentences, which is the whole
    point of composing them. The editor needs the parts back to reopen a form on an existing offer.

    ⚠️ All nullable, and null is a real state rather than missing data: offers created before the
    form was constrained carry hand-written prose and no parts at all. The admin page shows those as
    needing re-entry — there is no honest way to parse a noun back out of a free-form sentence.
  */
  itemLabel: string | null;
  requiredItem: string | null;
  requiredGender: DealGender | null;
  /* percentage only. Null = the whole bill; otherwise a menu section's title, not its id — see the
     column comment for why an FK would break on every menu save. */
  scopeLabel: string | null;
};

/*
  A photo with a handle on it.

  The public shape is a bare array of URLs, which is all a client needs to render them and useless
  for anything else — you cannot delete or reorder something you can't name. Admin gets the row id
  and the position.
*/
export type AdminPhoto = {
  id: string;
  /* Full URL, composed from ASSET_BASE_URL like every other image the API sends. */
  url: string;
  /* Lowest wins: the first photo is the card image everywhere in the product. There is no
     is_primary column — position IS the answer. */
  sortOrder: number;
};

export type AdminMenuItem = {
  id: string;
  name: string;
  /* The public projection drops this entirely; the editor needs it to round-trip. */
  description: string | null;
  /* Minor units (bani). The VENUE'S OWN price, undiscounted. */
  priceMinor: number;
  currency: string;
  /* ⚠️ Unavailable items are filtered out of the public menu, so this switch decides whether a
     member sees the line at all. */
  isAvailable: boolean;
};

export type AdminMenuSection = {
  id: string;
  title: string;
  items: AdminMenuItem[];
};

export type AdminVenue = Omit<VenueDetail, "deals" | "photos" | "menu"> & {
  /* ⚠️ EVERY deal, not just the active ones — this deliberately shadows VenueDetail["deals"],
     which is the active subset the app sees. */
  deals: AdminDeal[];
  /* Shadows VenueDetail["photos"], which is string[]. */
  photos: AdminPhoto[];
  /*
    The menu, flattened out of the public `Menu | null` object.

    An editor has to be able to SET the kind to start a price list on a venue that has none, and
    sections can exist while kind is still null, so a nullable wrapper around both is the wrong
    shape here even though it's the right one for a client that just renders what it's given.
  */
  menuKind: Menu["kind"] | null;
  menuSections: AdminMenuSection[];
  /*
    The full week, for the hours editor. `todayHours` inherited from VenueDetail stays as it is —
    it answers "what are today's hours" for a display line, and this answers "what does the whole
    schedule look like" for a form. Different questions, so both are here.
  */
  weekHours: VenueHoursWindow[];
  isPublished: boolean;
  /* Null is a real state, not missing data — venues get created before the company behind them
     exists, and all 30 seeded ones have no partner at all. */
  partner: { id: string; companyName: string } | null;
  /*
    Which subcategories this venue is filed under, as keys.

    ⚠️ Admin-only on purpose, and it is NOT the same thing as `tags`. Subcategories are a controlled
    list the app's filters actually query on; tags are free text the venue describes itself with.
    The public catalogue never sends either the assignments or the keys — it exposes the taxonomy
    through /v1/categories and filters by it server-side, which is all a client needs.

    A venue has exactly one category but any number of subcategories, and every key here belongs
    to that one category — the write path enforces it.
  */
  subcategoryKeys: string[];
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

/*
  A venue_owner account, as the partner detail page lists them.

  ⚠️ Carries no credential of any kind, and can't: `users` has no password column and invite tokens
  are stored SHA-256 only. The plaintext link exists exactly once, in the response that mints it.

  All four timestamps are ISO 8601 UTC, rendered in Europe/Bucharest. `inviteAcceptedAt === null` is
  what "invitation still outstanding" means — the flag the resend action keys off.
*/
export type PartnerUserSummary = {
  id: string;
  email: string;
  name: string;
  invitedAt: string | null;
  inviteExpiresAt: string | null;
  inviteAcceptedAt: string | null;
  /* Computed in SQL against the database clock. ⚠️ Don't re-derive this in a client by comparing
     inviteExpiresAt to Date.now() — that's a hydration mismatch, and it's why the server sends it. */
  inviteExpired: boolean;
  lastLoginAt: string | null;
  /* How many locations they were granted. Zero is legitimate — an owner invited before their venue
     existed — and the partner dashboard's switcher already handles that case. */
  venueCount: number;
};

/* The detail response carries the company's sign-in accounts; the list response deliberately
   doesn't, since no screen renders them there. */
export type PartnerDetail = Partner & { users: PartnerUserSummary[] };

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
      /* A subcategory key that doesn't exist, or belongs to a different category than the one the
         venue is being filed under. Usually means the category changed and the old category's
         subcategories came along with it. */
      | "SUBCATEGORY_INVALID"
      /* A deal id that doesn't exist, or belongs to a different venue than the one in the path. */
      | "DEAL_NOT_FOUND"
      /* Same, for a photo. Also covers a reorder whose id list doesn't match the venue's photos. */
      | "PHOTO_NOT_FOUND"
      /* An upload that isn't one of the image types we accept. */
      | "UNSUPPORTED_MEDIA_TYPE"
      | "FILE_TOO_LARGE"
      /* R2 refused the write. Ours to fix, not the caller's — always logged server-side. */
      | "UPLOAD_FAILED"
      | "PARTNER_NOT_FOUND"
      | "LEAD_NOT_FOUND"
      | "ACTING_ADMIN_MISSING";
    /* Field-level detail for INVALID_QUERY / INVALID_BODY. Developer-facing, never shown to a
       member. */
    details?: unknown;
  };
};
