CREATE TABLE "redemption_ratings" (
	"redemption_id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"stars" smallint,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redemption_ratings_stars_range" CHECK ("redemption_ratings"."stars" IS NULL OR "redemption_ratings"."stars" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "redemption_ratings" ADD CONSTRAINT "redemption_ratings_redemption_id_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."redemptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_ratings" ADD CONSTRAINT "redemption_ratings_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_ratings" ADD CONSTRAINT "redemption_ratings_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redemption_ratings_venue_idx" ON "redemption_ratings" USING btree ("venue_id","created_at" DESC NULLS LAST);