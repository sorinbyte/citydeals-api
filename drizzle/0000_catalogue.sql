CREATE TABLE "categories" (
	"key" text PRIMARY KEY NOT NULL,
	"label_ro" text NOT NULL,
	"image_path" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"avg_saving_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'RON' NOT NULL,
	"refresh_days" smallint NOT NULL,
	"people" smallint DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subcategories" (
	"key" text PRIMARY KEY NOT NULL,
	"category_key" text NOT NULL,
	"label_ro" text NOT NULL,
	"emoji" text,
	"image_path" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_photos" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_subcategories" (
	"venue_id" uuid NOT NULL,
	"subcategory_key" text NOT NULL,
	CONSTRAINT "venue_subcategories_venue_id_subcategory_key_pk" PRIMARY KEY("venue_id","subcategory_key")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category_key" text NOT NULL,
	"area" text NOT NULL,
	"address" text NOT NULL,
	"phone" text,
	"location" geography(Point, 4326) NOT NULL,
	"rating" numeric(2, 1),
	"rating_count" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_hours" ADD CONSTRAINT "opening_hours_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_category_key_categories_key_fk" FOREIGN KEY ("category_key") REFERENCES "public"."categories"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_photos" ADD CONSTRAINT "venue_photos_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_subcategories" ADD CONSTRAINT "venue_subcategories_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_subcategories" ADD CONSTRAINT "venue_subcategories_subcategory_key_subcategories_key_fk" FOREIGN KEY ("subcategory_key") REFERENCES "public"."subcategories"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_category_key_categories_key_fk" FOREIGN KEY ("category_key") REFERENCES "public"."categories"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_venue_idx" ON "deals" USING btree ("venue_id","sort_order");--> statement-breakpoint
CREATE INDEX "opening_hours_venue_idx" ON "opening_hours" USING btree ("venue_id","weekday");--> statement-breakpoint
CREATE INDEX "subcategories_category_idx" ON "subcategories" USING btree ("category_key");--> statement-breakpoint
CREATE INDEX "venue_photos_venue_idx" ON "venue_photos" USING btree ("venue_id","sort_order");--> statement-breakpoint
CREATE INDEX "venue_subcategories_subcategory_idx" ON "venue_subcategories" USING btree ("subcategory_key");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_slug_key" ON "venues" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "venues_category_idx" ON "venues" USING btree ("category_key");--> statement-breakpoint
CREATE INDEX "venues_location_idx" ON "venues" USING gist ("location");