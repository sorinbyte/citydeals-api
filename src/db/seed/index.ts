import { eq, sql } from "drizzle-orm";

import { db, pool } from "@/db/client";
import {
  categories,
  deals,
  members,
  menuItems,
  menuSections,
  openingHours,
  partnerLeads,
  partners,
  subcategories,
  users,
  venuePhotos,
  venueSubcategories,
  venues,
} from "@/db/schema";
import { dealsByVenueSlug } from "@/db/seed/data/deals";
import { leadSeed } from "@/db/seed/data/leads";
import { menuArchetypes, menuByVenueSlug } from "@/db/seed/data/menus";
import { partnerSeed } from "@/db/seed/data/partners";
import { categorySeed, hoursByCategory, subcategorySeed } from "@/db/seed/data/taxonomy";
import { venueSeed } from "@/db/seed/data/venues";

/*
  Loads the placeholder catalogue. Safe to re-run — it truncates the venue side first, so you get
  the same result every time instead of 30 more venues.

  ⚠️ This TRUNCATES the whole catalogue before inserting. It's guarded by an explicit opt-in
  because "I pointed .env at the production branch for five minutes" is a normal Tuesday mistake.

  The guard is an env flag rather than a check on the connection string, because a Neon URL doesn't
  tell you which branch it points at — the endpoint is a random `ep-...` id and the branch name
  appears nowhere in it. So sniffing the URL for "dev" would be security theatre that also happens
  to never work. Instead: the dev .env opts in, and a production environment simply never sets this.
*/
function assertSafeTarget(): void {
  if (process.env.ALLOW_SEED !== "yes") {
    throw new Error(
      "Refusing to seed: ALLOW_SEED is not set to 'yes'. This truncates every catalogue table. " +
        "Set ALLOW_SEED=yes in your local .env (pointed at Neon's `development` branch). " +
        "Never set it in a production environment.",
    );
  }
}

/*
  The account every seeded partner is filed under.

  `.invalid` is reserved by RFC 2606 and can never resolve, so this address is guaranteed not to
  belong to a real person — and it doubles as the seed's PROVENANCE MARKER. `partners` already
  carries `created_by_user_id` for audit reasons; that column is what lets the seed recognise its
  own rows and leave everyone else's alone.
*/
const SEED_ADMIN_EMAIL = "seed-admin@citydeals.invalid";

/* Same trick for leads, which have no created_by. Every seeded lead's email is on a `.invalid`
   domain, so a genuine lead from the marketing form can never be mistaken for one. */
const SEED_LEAD_EMAIL_PATTERN = "%.invalid";

/*
  The catalogue truncate is not as contained as it looks.

  `TRUNCATE venues CASCADE` reaches photos, deals, hours and subcategory links — all placeholder
  data, all reinserted moments later. Since venues gained a partner it also reaches `user_venues`
  (every venue_owner's scoping grants) and resets `venues.partner_id` to NULL. Partners themselves
  survive and look perfectly healthy while every company→location link is gone, which is what makes
  that one nasty to spot.

  Now that the seed OWNS partners and leads, "refuse if any partner exists" would mean never being
  able to re-run it. So the test is ownership, not existence: refuse if the database holds identity
  data this seed did not create.

    · members — the seed never creates one. Any row here is a real person who verified a real
      phone number, and no dev convenience command gets to touch that.
    · users other than the seed admin — a real account, invited or not.
    · partners not filed under the seed admin — somebody added a genuine company through admin.
    · leads on a non-`.invalid` domain — a genuine inbound lead. `POST /partner-leads` doesn't
      exist yet, so there are none today; it's next on the list, which is exactly why this check
      goes in now rather than after the first one is lost.

  ALLOW_SEED doesn't help with any of this: it guards the catalogue wipe it was written for, and
  this is real data that only LOOKS like catalogue data because it hangs off the same FKs.
*/
async function assertOnlySeedIdentityData(): Promise<void> {
  const [row] = await db
    .select({
      members: sql<number>`(SELECT count(*) FROM ${members})::int`,
      users: sql<number>`(SELECT count(*) FROM ${users}
        WHERE lower(${users.email}) <> ${SEED_ADMIN_EMAIL})::int`,
      partners: sql<number>`(SELECT count(*) FROM ${partners}
        WHERE ${partners.createdByUserId} NOT IN (
          SELECT id FROM ${users} WHERE lower(${users.email}) = ${SEED_ADMIN_EMAIL}
        ))::int`,
      leads: sql<number>`(SELECT count(*) FROM ${partnerLeads}
        WHERE ${partnerLeads.email} NOT LIKE ${SEED_LEAD_EMAIL_PATTERN})::int`,
    })
    .from(sql`(SELECT 1) AS _`);

  const found = [
    [row?.members ?? 0, "member(s)"],
    [row?.users ?? 0, "non-seed user(s)"],
    [row?.partners ?? 0, "partner(s) not created by the seed"],
    [row?.leads ?? 0, "real lead(s)"],
  ] as const;

  const problems = found.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to seed: this database holds identity data the seed does not own — ${problems.join(", ")}. Re-seeding would delete venue grants, detach partners from their locations and wipe real leads. Remove those rows deliberately first if you really mean it.`,
  );
}

async function seed(): Promise<void> {
  assertSafeTarget();
  await assertOnlySeedIdentityData();

  await db.transaction(async (tx) => {
    /*
      Clear the seed's own identity rows first, in FK order.

      Leads before partners because a converted lead points at one. Partners before the admin
      because `partners.created_by_user_id` is ON DELETE RESTRICT — deleting the admin first is
      refused, which is the audit trail doing its job.

      Deleting a partner cascades to its venue_owner users and NULLs `venues.partner_id`, so
      there's nothing else to unpick by hand.
    */
    await tx.execute(
      sql`DELETE FROM ${partnerLeads} WHERE ${partnerLeads.email} LIKE ${SEED_LEAD_EMAIL_PATTERN}`,
    );
    await tx.execute(sql`DELETE FROM ${partners} WHERE ${partners.createdByUserId} IN (
      SELECT id FROM ${users} WHERE lower(${users.email}) = ${SEED_ADMIN_EMAIL}
    )`);
    await tx.execute(sql`DELETE FROM ${users} WHERE lower(${users.email}) = ${SEED_ADMIN_EMAIL}`);

    /*
      CASCADE takes the photos, deals, hours and subcategory links with it — they all hang off
      venues by FK. RESTART IDENTITY isn't needed since every id is a uuid.
    */
    await tx.execute(sql`TRUNCATE TABLE ${venues} CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE ${categories} CASCADE`);

    await tx.insert(categories).values([...categorySeed]);
    await tx.insert(subcategories).values([...subcategorySeed]);

    /* Venue ids are generated, so the partner fixtures key on slug and get resolved here. */
    const venueIdBySlug = new Map<string, string>();

    for (const v of venueSeed) {
      const archetype = menuByVenueSlug[v.slug];
      const menu = archetype ? menuArchetypes[archetype] : undefined;

      const [row] = await tx
        .insert(venues)
        .values({
          slug: v.slug,
          name: v.name,
          categoryKey: v.categoryKey,
          area: v.area,
          address: v.address,
          phone: v.phone,
          location: { lat: v.lat, lng: v.lng },
          rating: v.rating,
          ratingCount: v.ratingCount,
          tags: v.tags,
          isNew: v.isNew ?? false,
          // null for venues with no price list — the client hides the button rather than
          // opening an empty sheet
          menuKind: menu?.kind ?? null,
        })
        .returning({ id: venues.id });

      // insert … returning always gives a row here, but noUncheckedIndexedAccess doesn't know that
      if (!row) throw new Error(`failed to insert venue ${v.slug}`);
      venueIdBySlug.set(v.slug, row.id);

      if (v.subcategories?.length) {
        await tx
          .insert(venueSubcategories)
          .values(v.subcategories.map((key) => ({ venueId: row.id, subcategoryKey: key })));
      }

      await tx
        .insert(venuePhotos)
        .values(v.photos.map((path, i) => ({ venueId: row.id, path, sortOrder: i })));

      const venueDeals = dealsByVenueSlug[v.slug] ?? [];
      if (venueDeals.length) {
        await tx.insert(deals).values(
          venueDeals.map((deal, i) => ({
            venueId: row.id,
            type: deal.type,
            title: deal.title,
            condition: deal.condition,
            // null for everything that isn't a percentage deal — the CHECK constraint enforces it
            percentOff: deal.percentOff ?? null,
            avgSavingMinor: deal.avgSavingMinor,
            refreshDays: deal.refreshDays,
            people: deal.people,
            sortOrder: i,
          })),
        );
      }

      // sections one at a time — each item batch needs its parent section's id back
      if (menu) {
        for (const [sectionIndex, section] of menu.sections.entries()) {
          const [sectionRow] = await tx
            .insert(menuSections)
            .values({ venueId: row.id, title: section.title, sortOrder: sectionIndex })
            .returning({ id: menuSections.id });

          if (!sectionRow) throw new Error(`failed to insert menu section for ${v.slug}`);

          await tx.insert(menuItems).values(
            section.items.map((item, itemIndex) => ({
              sectionId: sectionRow.id,
              name: item.name,
              priceMinor: item.priceMinor,
              sortOrder: itemIndex,
            })),
          );
        }
      }

      const blocks = hoursByCategory[v.categoryKey] ?? [];
      const hourRows = blocks.flatMap((block) =>
        block.weekdays.map((weekday) => ({
          venueId: row.id,
          weekday,
          opensAt: block.opens,
          closesAt: block.closes,
        })),
      );
      if (hourRows.length) await tx.insert(openingHours).values(hourRows);
    }

    /* --- partners, their locations, and the leads ------------------------------------------ */

    /*
      One platform_owner to hang the fixtures off. `partners.created_by_user_id` is NOT NULL — the
      audit trail is not optional — so a company cannot exist without an admin who added it.

      partner_id stays NULL here: a platform_owner works for the platform, not for a company, and
      the users_partner_matches_role CHECK enforces that.
    */
    const [seedAdmin] = await tx
      .insert(users)
      .values({
        email: SEED_ADMIN_EMAIL,
        name: "Seed Admin",
        role: "platform_owner",
      })
      .returning({ id: users.id });

    if (!seedAdmin) throw new Error("failed to insert the seed admin user");

    const partnerIdByCui = new Map<string, string>();

    for (const p of partnerSeed) {
      const [partnerRow] = await tx
        .insert(partners)
        .values({
          companyName: p.companyName,
          cui: p.cui,
          status: p.status,
          contactName: p.contactName,
          contactEmail: p.contactEmail,
          contactPhone: p.contactPhone,
          createdByUserId: seedAdmin.id,
        })
        .returning({ id: partners.id });

      if (!partnerRow) throw new Error(`failed to insert partner ${p.companyName}`);
      partnerIdByCui.set(p.cui, partnerRow.id);

      /*
        Attach the locations. A typo in a slug would otherwise leave a partner silently owning
        nothing, which looks like a UI bug three screens later — so it throws here instead.
      */
      for (const slug of p.venueSlugs) {
        const venueId = venueIdBySlug.get(slug);
        if (!venueId)
          throw new Error(`partner ${p.companyName} references unknown venue "${slug}"`);

        await tx.update(venues).set({ partnerId: partnerRow.id }).where(eq(venues.id, venueId));
      }
    }

    await tx.insert(partnerLeads).values(
      leadSeed.map((lead) => ({
        venueName: lead.venueName,
        contactName: lead.contactName,
        category: lead.category,
        phone: lead.phone,
        email: lead.email,
        message: lead.message ?? null,
        notes: lead.notes ?? null,
        status: lead.status,
        // the converted one points at the company it became; everything else is null
        convertedPartnerId: lead.convertedPartnerCui
          ? (partnerIdByCui.get(lead.convertedPartnerCui) ?? null)
          : null,
      })),
    );
  });

  const [counts] = await db
    .select({
      venues: sql<number>`(SELECT count(*) FROM ${venues})::int`,
      deals: sql<number>`(SELECT count(*) FROM ${deals})::int`,
      photos: sql<number>`(SELECT count(*) FROM ${venuePhotos})::int`,
      menuSections: sql<number>`(SELECT count(*) FROM ${menuSections})::int`,
      menuItems: sql<number>`(SELECT count(*) FROM ${menuItems})::int`,
      hours: sql<number>`(SELECT count(*) FROM ${openingHours})::int`,
      partners: sql<number>`(SELECT count(*) FROM ${partners})::int`,
      // the number worth watching: a partner whose slugs didn't resolve would show up here
      linkedVenues: sql<number>`(SELECT count(*) FROM ${venues} WHERE ${venues.partnerId} IS NOT NULL)::int`,
      leads: sql<number>`(SELECT count(*) FROM ${partnerLeads})::int`,
    })
    .from(sql`(SELECT 1) AS _`);

  console.log("seeded:", counts);
}

try {
  await seed();
} finally {
  await pool.end();
}
