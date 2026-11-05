CREATE TABLE "food_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"logged_on" date NOT NULL,
	"slot" text,
	"food_id" uuid,
	"name" text NOT NULL,
	"grams" numeric(6, 1) NOT NULL,
	"kcal" numeric(7, 1) NOT NULL,
	"protein_g" numeric(6, 1) NOT NULL,
	"carbs_g" numeric(6, 1) NOT NULL,
	"fat_g" numeric(6, 1) NOT NULL,
	"fibre_g" numeric(6, 1),
	"via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_log_via_check" CHECK ("food_log"."via" in ('scan', 'search', 'quick_add')),
	CONSTRAINT "food_log_grams_check" CHECK ("food_log"."grams" > 0 and "food_log"."grams" <= 5000)
);
--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "nutriscore_grade" text;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "nutri_category" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "nova_group" integer;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "additives" text[];--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "ingredients_text" text;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "off_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "food_log" ADD CONSTRAINT "food_log_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_log" ADD CONSTRAINT "food_log_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_log_user_day_idx" ON "food_log" USING btree ("user_id","logged_on");--> statement-breakpoint
CREATE UNIQUE INDEX "food_user_barcode_unique" ON "food" USING btree ("user_id","barcode") WHERE "food"."barcode" is not null;--> statement-breakpoint
ALTER TABLE "food" ADD CONSTRAINT "food_nutri_category_check" CHECK ("food"."nutri_category" in ('general', 'cheese', 'red_meat'));