CREATE TYPE "public"."deal_gender" AS ENUM('m', 'f');--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "item_label" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "required_item" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "required_gender" "deal_gender";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "scope_label" text;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_required_gender_matches_item" CHECK (("deals"."required_item" IS NULL) = ("deals"."required_gender" IS NULL));