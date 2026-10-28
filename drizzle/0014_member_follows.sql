CREATE TABLE "follows" (
	"follower_member_id" uuid NOT NULL,
	"followee_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_member_id_followee_member_id_pk" PRIMARY KEY("follower_member_id","followee_member_id"),
	CONSTRAINT "follows_not_self" CHECK ("follows"."follower_member_id" <> "follows"."followee_member_id")
);
--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_member_id_members_id_fk" FOREIGN KEY ("follower_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_member_id_members_id_fk" FOREIGN KEY ("followee_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follows_followee_idx" ON "follows" USING btree ("followee_member_id");