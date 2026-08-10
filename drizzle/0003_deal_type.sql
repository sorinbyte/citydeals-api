-- Hand-added, and the only edited line in this file.
--
-- `type` and `condition` come in NOT NULL with no default, which Postgres rejects outright if the
-- table has rows. There is no sensible backfill either: the old `description` was prose, and
-- nothing can infer whether a given deal is a 1+1 or a percentage from it. So the placeholder rows
-- go, and `npm run db:seed` puts them back with real types a second later.
--
-- ⚠️ Safe ONLY because deals are seeded placeholder data pre-launch. The day a partner's real deal
-- lives in here, a change like this needs a backfill, not a DELETE.
DELETE FROM "deals";--> statement-breakpoint
CREATE TYPE "public"."deal_type" AS ENUM('one_plus_one', 'free_item', 'percentage');--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "type" "deal_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "condition" text NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "percent_off" smallint;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_percent_off_matches_type" CHECK (("deals"."type" = 'percentage' AND "deals"."percent_off" BETWEEN 1 AND 100)
          OR ("deals"."type" <> 'percentage' AND "deals"."percent_off" IS NULL));