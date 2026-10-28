CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"inviter_member_id" uuid NOT NULL,
	"invitee_member_id" uuid NOT NULL,
	"inviter_rewarded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_member_id_members_id_fk" FOREIGN KEY ("inviter_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invitee_member_id_members_id_fk" FOREIGN KEY ("invitee_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invitee_key" ON "referrals" USING btree ("invitee_member_id");--> statement-breakpoint
CREATE INDEX "referrals_inviter_idx" ON "referrals" USING btree ("inviter_member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "members_referral_code_key" ON "members" USING btree ("referral_code");