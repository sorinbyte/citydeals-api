import {
  type AnyPgColumn,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestamps } from "@/db/schema/columns";
import { users } from "@/db/schema/identity";

/*
  The commercial side: the companies we sign, and the people who ask to be signed.

  A `partner` is a COMPANY (an SRL with a CUI), not a login. The person who logs in to
  partner.<domain> is a row in `users` with role venue_owner, pointing here. Conflating the two is
  easy and wrong — a company can have several people on it, and suspending one of them must not
  suspend the company.
*/

/*
  How far along a partner record is.

    draft     — being filled in by an admin. Not signed, nothing live.
    confirmed — the paperwork is done and the company is really on the platform.

  Deliberately NOT the same axis as users.status (active/suspended). Confirming a company grants
  nobody access, and suspending a person doesn't unconfirm their company.

  Note what this does NOT control: whether a venue is visible in the app. That's venues.is_published,
  per location, because a confirmed partner can still have one location temporarily dark.
*/
export const partnerStatus = pgEnum("partner_status", ["draft", "confirmed"]);

/*
  Where a lead has got to. CODES, not the Romanian — same rule as menu_kind and deal_type: the API
  never hands a client a user-facing sentence, or copy needs a backend deploy to fix.

  ⚠️ The admin mock (apps/admin/src/lib/partners.ts) currently uses Romanian keys —
  nou/contactat/calificat/respins. Those are the LABELS. When admin gets wired, it maps these four
  codes to those words, the same way it already maps category keys.
*/
export const leadStatus = pgEnum("lead_status", ["new", "contacted", "qualified", "rejected"]);

export const partners = pgTable(
  "partners",
  {
    id: id(),
    // denumire societate, exactly as it appears on the paperwork
    companyName: text("company_name").notNull(),
    /*
      Codul Unic de Înregistrare.

      Stored NORMALISED: digits only, no "RO" prefix, no spaces. The same company writes it three
      ways across a contract, an email and a form, and a unique index on the raw string would
      happily accept "RO12345678" and "12345678" as two different partners.

      The checksum is validated in the service layer, not here — a CHECK constraint doing modular
      arithmetic is unreadable and unmaintainable, and the rule belongs where it can produce a
      decent error code.
    */
    cui: text("cui").notNull(),
    status: partnerStatus("status").notNull().default("draft"),

    // the human we actually deal with. Not a login — see the note at the top of this file.
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    // E.164, same storage rule as venues.phone. Never prettified.
    contactPhone: text("contact_phone").notNull(),

    /*
      Which admin added this partner. AGENTS.md asks for an audit trail where it matters, and
      "who signed this company" is a question that gets asked during a dispute.

      RESTRICT, not SET NULL: erasing the answer is worse than blocking the delete. In practice an
      admin who's created partners gets suspended rather than deleted, which this doesn't touch.
    */
    /*
      The `: AnyPgColumn` is load-bearing, not decoration. users.partner_id points here and this
      points back, and without an explicit annotation somewhere in that loop TypeScript gives up
      and infers `any` for both tables — which compiles, and then silently costs you every column
      type in the schema.
    */
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("partners_cui_key").on(t.cui),
    index("partners_status_idx").on(t.status),
    index("partners_created_by_idx").on(t.createdByUserId),
  ],
);

/*
  Somebody who filled in the form on the marketing site.

  A lead is NOT an account and grants nothing. Converting one means an admin creating a partner and
  sending an invite — which is what keeps venue verification on our side of the wire. There is no
  public partner signup and there never will be one.
*/
export const partnerLeads = pgTable(
  "partner_leads",
  {
    id: id(),
    venueName: text("venue_name").notNull(),
    contactName: text("contact_name").notNull(),
    /*
      A category key from /v1/categories, or the literal "altceva".

      Plain text and deliberately NOT a foreign key: "altceva" is not a category and never will be,
      and a lead is a historical record — it shouldn't break or vanish because a category was
      renamed a year later.
    */
    category: text("category").notNull(),
    phone: text("phone").notNull(),
    email: text("email").notNull(),
    /*
      What the LEAD wrote in the form's free-text box. Optional there, so nullable here.

      Not to be confused with `notes` below — this is theirs, that one is ours. The marketing form
      sends this one (marketing/src/api/partner-leads.ts).
    */
    message: text("message"),
    /*
      What WE write while working the lead ("Sunat, revine joi"). Never shown to the lead.
      Admin-only, and the reason these are two columns rather than one.
    */
    notes: text("notes"),
    status: leadStatus("status").notNull().default("new"),
    /*
      What this lead became, if anything. Nullable — most leads never convert.

      Worth the column: without it, "how many leads turn into partners" can only be answered by
      matching company names by hand, and the lead stops being the record of where the relationship
      started.
    */
    convertedPartnerId: uuid("converted_partner_id").references(() => partners.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  /*
    The Lead-uri tab lists newest first and badges the unworked ones, so status carries the
    created_at with it. `receivedAt` in the admin mock is just created_at — no separate column.
  */
  (t) => [index("partner_leads_status_idx").on(t.status, t.createdAt)],
);
