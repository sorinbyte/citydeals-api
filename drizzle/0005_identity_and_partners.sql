CREATE TYPE "public"."user_role" AS ENUM('platform_owner', 'venue_owner');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."partner_status" AS ENUM('draft', 'confirmed');--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"phone" text NOT NULL,
	"phone_verified_at" timestamp with time zone NOT NULL,
	"name" text,
	"trial_started_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_venues" (
	"user_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_venues_user_id_venue_id_pk" PRIMARY KEY("user_id","venue_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"partner_id" uuid,
	"invited_at" timestamp with time zone,
	"invite_expires_at" timestamp with time zone,
	"invite_accepted_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_partner_matches_role" CHECK (("users"."role" = 'platform_owner' AND "users"."partner_id" IS NULL)
          OR ("users"."role" = 'venue_owner' AND "users"."partner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "partner_leads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"category" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"message" text,
	"notes" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"converted_partner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"company_name" text NOT NULL,
	"cui" text NOT NULL,
	"status" "partner_status" DEFAULT 'draft' NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "partner_id" uuid;--> statement-breakpoint
ALTER TABLE "user_venues" ADD CONSTRAINT "user_venues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_venues" ADD CONSTRAINT "user_venues_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_converted_partner_id_partners_id_fk" FOREIGN KEY ("converted_partner_id") REFERENCES "public"."partners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "members_phone_key" ON "members" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "members_trial_ends_idx" ON "members" USING btree ("trial_ends_at");--> statement-breakpoint
CREATE INDEX "user_venues_venue_idx" ON "user_venues" USING btree ("venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_partner_idx" ON "users" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_leads_status_idx" ON "partner_leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_cui_key" ON "partners" USING btree ("cui");--> statement-breakpoint
CREATE INDEX "partners_status_idx" ON "partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "partners_created_by_idx" ON "partners" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "venues_partner_idx" ON "venues" USING btree ("partner_id");