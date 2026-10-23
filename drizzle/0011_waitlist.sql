CREATE TABLE "waitlist_signups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirm_token_hash" text,
	"confirm_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_signups_email_key" ON "waitlist_signups" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_signups_confirm_token_key" ON "waitlist_signups" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE INDEX "waitlist_signups_created_idx" ON "waitlist_signups" USING btree ("created_at");