import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { env } from "@/lib/env";
import type { LeadStatus, Partner, PartnerLead, PartnerStatus, PartnerVenue } from "@/types/api";

/*
  Reads and writes behind the admin dashboard.

  Same two habits as services/venues.ts: one round trip per request, and rows shaped in SQL then
  mapped once here. Routes never touch a raw row.
*/

/*
  Digits only — no "RO" prefix, no spaces, no dots.

  The same company writes its CUI three different ways across a contract, an email and a form, and
  `partners_cui_key` is a UNIQUE index on the stored string. Normalising here, server-side, is what
  actually enforces it: the admin form normalises too, but that's for the person typing, and a
  rule only checked in a browser is a rule someone can skip.
*/
export function normaliseCui(raw: string): string {
  return raw.replace(/^\s*ro/i, "").replace(/\D/g, "");
}

/*
  Romanian CUI check digit — key 753217532, right-aligned against the number without its last
  digit, sum the products, ×10, mod 11, and 10 counts as 0.

  Checked here as well as in the form because a CUI is the company's legal identifier: it goes on
  the contract and the invoice, and it's unique in this table. A typo either blocks the real
  company later or files locations under one that doesn't exist.
*/
const CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];

export function isValidCui(raw: string): boolean {
  const digits = normaliseCui(raw);
  // 2 is the shortest CUI actually issued; 10 is the longest the key covers (9 + check digit)
  if (!/^\d{2,10}$/.test(digits)) return false;

  const body = digits.slice(0, -1).split("").map(Number);
  const control = Number(digits.slice(-1));
  const key = CUI_KEY.slice(CUI_KEY.length - body.length);
  const sum = body.reduce((total, digit, i) => total + digit * (key[i] ?? 0), 0);
  const expected = (sum * 10) % 11;

  return (expected === 10 ? 0 : expected) === control;
}

type PartnerRow = {
  id: string;
  company_name: string;
  cui: string;
  status: PartnerStatus;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  /* Already camelCase and already the right shape — this one column comes out of Postgres as
     JSON rather than as flat text, so toPartner passes it through untouched. */
  venues: PartnerVenue[];
  created_at: string;
};

function toPartner(row: PartnerRow): Partner {
  return {
    id: row.id,
    companyName: row.company_name,
    cui: row.cui,
    status: row.status,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    venues: row.venues,
    createdAt: row.created_at,
  };
}

/*
  The locations each partner runs, as aggregated JSON rather than a follow-up query per row —
  same N+1 reasoning as the catalogue. COALESCE because a brand-new company has no venues yet and
  every caller would otherwise have to defend against null.

  ⚠️ This is the ONLY place in the repo that reads venues.partner_id, and it must stay that way.
  The public catalogue's projection is summaryColumns in services/venues.ts — a separate block on
  purpose, so widening this one can't leak an admin field into what the mobile app reads.

  The keys are camelCase, unlike every flat column here, because this JSON is handed to the client
  as-is. json_build_object is also why created_at needs no isoTimestamp treatment below: values
  inside it are JSON-serialised by Postgres, which already emits real ISO 8601. The helper exists
  for TOP-LEVEL timestamptz columns, which db.execute hands back as raw text.
*/
/*
  ⚠️ Timestamps go out through to_json, not raw.

  db.execute hands back whatever text Postgres printed, which for a timestamptz is
  "2026-08-07 23:18:27.923927+00" — a space instead of a T. `new Date()` on that is not defined by
  the spec: V8 is lenient and parses it, other engines return Invalid Date. Shipping it would mean
  a date column that works in Chrome and shows "Invalid Date" in Safari.

  to_json on a timestamptz produces real ISO 8601, and #>>'{}' unwraps the JSON string back to
  text. Every timestamp this file returns goes through it.
*/
const isoTimestamp = (column: ReturnType<typeof sql>) => sql`to_json(${column})#>>'{}'`;

const partnerColumns = sql`
  p.id,
  p.company_name,
  p.cui,
  p.status,
  p.contact_name,
  p.contact_email,
  p.contact_phone,
  ${isoTimestamp(sql`p.created_at`)} AS created_at,
  COALESCE((SELECT json_agg(json_build_object(
              'id', v.id,
              'slug', v.slug,
              'name', v.name,
              'categoryKey', v.category_key,
              'area', v.area,
              'isPublished', v.is_published,
              'createdAt', v.created_at
            ) ORDER BY v.name)
            FROM venues v WHERE v.partner_id = p.id), '[]'::json) AS venues
`;

/*
  Every partner, newest first.

  No pagination yet, deliberately: this is a curated network measured in tens, and a page size we
  invent now is one the admin table would have to learn to page through for no reason. It becomes
  paginated the same day it needs to be.
*/
export async function listPartners(): Promise<Partner[]> {
  const result = await db.execute(sql`
    SELECT ${partnerColumns} FROM partners p ORDER BY p.created_at DESC, p.id DESC
  `);

  return (result.rows as PartnerRow[]).map(toPartner);
}

/*
  One partner, through the same projection the list uses.

  Null rather than a throw when the id doesn't exist, so the route decides what a miss means — same
  shape as updateLeadStatus below. Deliberately NOT "find it in listPartners()": the admin page
  loads this directly on a hard refresh, and pulling every partner to return one is the kind of
  thing that's fine at thirty rows and embarrassing at three hundred.
*/
export async function getPartner(id: string): Promise<Partner | null> {
  const result = await db.execute(sql`
    SELECT ${partnerColumns} FROM partners p WHERE p.id = ${id}
  `);

  const row = result.rows[0] as PartnerRow | undefined;
  return row ? toPartner(row) : null;
}

/*
  Who a write is attributed to.

  Resolved from server config and NEVER from the request — a client-supplied user id would make
  `created_by_user_id` something the caller writes, which is worse than having no audit trail at
  all because it looks like one.

  Returns null rather than inventing an account: a missing acting admin is a misconfiguration, and
  silently creating a platform_owner to get past it is how a database ends up with users nobody
  remembers adding.
*/
async function actingAdminId(): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT id FROM users
    WHERE lower(email) = lower(${env.ADMIN_ACTING_EMAIL}) AND role = 'platform_owner'
    LIMIT 1
  `);

  return (result.rows[0] as { id: string } | undefined)?.id ?? null;
}

export type CreatePartnerInput = {
  companyName: string;
  cui: string;
  status: PartnerStatus;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
};

export type CreatePartnerResult =
  | { ok: true; partner: Partner }
  | { ok: false; reason: "CUI_TAKEN" | "ACTING_ADMIN_MISSING" };

export async function createPartner(input: CreatePartnerInput): Promise<CreatePartnerResult> {
  const createdBy = await actingAdminId();
  if (!createdBy) return { ok: false, reason: "ACTING_ADMIN_MISSING" };

  const cui = normaliseCui(input.cui);

  /*
    ON CONFLICT DO NOTHING rather than "SELECT then INSERT": checking first leaves a window where
    two requests both find nothing and both insert, and only the unique index decides who wins.
    Letting the index be the arbiter means the race can't happen at all — an empty result here IS
    the duplicate.
  */
  const inserted = await db.execute(sql`
    INSERT INTO partners (company_name, cui, status, contact_name, contact_email, contact_phone, created_by_user_id)
    VALUES (${input.companyName}, ${cui}, ${input.status}, ${input.contactName},
            ${input.contactEmail}, ${input.contactPhone}, ${createdBy})
    ON CONFLICT (cui) DO NOTHING
    RETURNING id
  `);

  const row = inserted.rows[0] as { id: string } | undefined;
  if (!row) return { ok: false, reason: "CUI_TAKEN" };

  /* Read it back through the same projection the list uses, so a created partner and a listed one
     are the same shape — including the empty `venues` array. */
  const result = await db.execute(sql`
    SELECT ${partnerColumns} FROM partners p WHERE p.id = ${row.id}
  `);

  return { ok: true, partner: toPartner(result.rows[0] as PartnerRow) };
}

/*
  A duplicate CUI, as Postgres reports it.

  UPDATE has no ON CONFLICT, so the trick createPartner uses isn't available here and the unique
  index throws instead. 23505 is unique_violation; the constraint name is checked too so that a
  future second unique index on this table doesn't quietly start reading as "CUI taken".

  ⚠️ The SQLSTATE is on error.cause, not on the error. Drizzle wraps whatever the driver threw in a
  DrizzleQueryError and hangs the original pg DatabaseError off `cause`, so a check against the top
  level alone matches nothing and every duplicate CUI comes back as a 500. Both levels are checked
  here so this keeps working if a future drizzle stops wrapping.
*/
function hasUniqueViolation(value: unknown, constraintName: string): boolean {
  if (typeof value !== "object" || value === null) return false;

  const { code, constraint } = value as { code?: string; constraint?: string };
  return code === "23505" && constraint === constraintName;
}

function isCuiConflict(error: unknown): boolean {
  if (hasUniqueViolation(error, "partners_cui_key")) return true;

  const cause = (error as { cause?: unknown } | null)?.cause;
  return hasUniqueViolation(cause, "partners_cui_key");
}

/* Same six fields as create. Everything else about a partner is either the database's to set
   (id, created_at) or a create-time fact that shouldn't move (created_by_user_id). */
export type UpdatePartnerInput = CreatePartnerInput;

export type UpdatePartnerResult =
  | { ok: true; partner: Partner }
  | { ok: false; reason: "NOT_FOUND" | "CUI_TAKEN" };

/*
  Edit a partner from the admin detail page.

  updated_at is set by hand because nothing in the database does it — there's no trigger on this
  table, only a DEFAULT now() that fires on INSERT. Miss this and the column silently claims every
  partner was last touched the day it was created.
*/
export async function updatePartner(
  id: string,
  input: UpdatePartnerInput,
): Promise<UpdatePartnerResult> {
  const cui = normaliseCui(input.cui);

  try {
    const updated = await db.execute(sql`
      UPDATE partners
      SET company_name  = ${input.companyName},
          cui           = ${cui},
          status        = ${input.status},
          contact_name  = ${input.contactName},
          contact_email = ${input.contactEmail},
          contact_phone = ${input.contactPhone},
          updated_at    = now()
      WHERE id = ${id}
      RETURNING id
    `);

    if (!updated.rows[0]) return { ok: false, reason: "NOT_FOUND" };
  } catch (error) {
    if (isCuiConflict(error)) return { ok: false, reason: "CUI_TAKEN" };
    throw error;
  }

  /* Read back through the shared projection so an edited partner, a created one and a listed one
     are all the same shape — including the venues the caller is about to re-render. */
  const partner = await getPartner(id);
  return partner ? { ok: true, partner } : { ok: false, reason: "NOT_FOUND" };
}

/* ------------------------------------------------------------------------------------------- */
/* Leads                                                                                        */

type LeadRow = {
  id: string;
  venue_name: string;
  contact_name: string;
  category: string;
  phone: string;
  email: string;
  message: string | null;
  notes: string | null;
  status: LeadStatus;
  converted_partner_id: string | null;
  created_at: string;
};

function toLead(row: LeadRow): PartnerLead {
  return {
    id: row.id,
    venueName: row.venue_name,
    contactName: row.contact_name,
    category: row.category,
    phone: row.phone,
    email: row.email,
    message: row.message,
    notes: row.notes,
    status: row.status,
    convertedPartnerId: row.converted_partner_id,
    createdAt: row.created_at,
  };
}

const leadColumns = sql`
  l.id, l.venue_name, l.contact_name, l.category, l.phone, l.email,
  l.message, l.notes, l.status, l.converted_partner_id,
  ${isoTimestamp(sql`l.created_at`)} AS created_at
`;

/* Newest first — the question this list answers is "who just got in touch". */
export async function listLeads(): Promise<PartnerLead[]> {
  const result = await db.execute(sql`
    SELECT ${leadColumns} FROM partner_leads l ORDER BY l.created_at DESC, l.id DESC
  `);

  return (result.rows as LeadRow[]).map(toLead);
}

/*
  Move a lead along the pipeline. Null when the id doesn't exist, so the route can answer 404
  rather than pretending a write happened.

  Only the status moves. Everything else on a lead is what the person typed into the marketing
  form, and it isn't ours to edit.
*/
export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
): Promise<PartnerLead | null> {
  const result = await db.execute(sql`
    UPDATE partner_leads l
    SET status = ${status}, updated_at = now()
    WHERE l.id = ${id}
    RETURNING ${leadColumns}
  `);

  const row = result.rows[0] as LeadRow | undefined;
  return row ? toLead(row) : null;
}
