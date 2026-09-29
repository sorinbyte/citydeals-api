CREATE TABLE "member_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"member_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"short_code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "pin_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "pin_failed_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "pin_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_sessions" ADD CONSTRAINT "member_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_devices" ADD CONSTRAINT "venue_devices_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_sessions_hash_key" ON "member_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "member_sessions_member_idx" ON "member_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "phone_verifications_phone_idx" ON "phone_verifications" USING btree ("phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_token_hash_key" ON "redemptions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_one_live_per_member" ON "redemptions" USING btree ("member_id") WHERE consumed_at IS NULL AND voided_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_venue_short_code_key" ON "redemptions" USING btree ("venue_id","short_code_hash") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "redemptions_member_deal_idx" ON "redemptions" USING btree ("member_id","deal_id","consumed_at");--> statement-breakpoint
CREATE INDEX "redemptions_venue_idx" ON "redemptions" USING btree ("venue_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "venue_devices_hash_key" ON "venue_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "venue_devices_venue_idx" ON "venue_devices" USING btree ("venue_id");