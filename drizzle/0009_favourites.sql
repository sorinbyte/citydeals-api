CREATE TABLE "member_favourites" (
	"member_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_favourites_member_id_venue_id_pk" PRIMARY KEY("member_id","venue_id")
);
--> statement-breakpoint
ALTER TABLE "member_favourites" ADD CONSTRAINT "member_favourites_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_favourites" ADD CONSTRAINT "member_favourites_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_favourites_recent_idx" ON "member_favourites" USING btree ("member_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "member_favourites_venue_idx" ON "member_favourites" USING btree ("venue_id");