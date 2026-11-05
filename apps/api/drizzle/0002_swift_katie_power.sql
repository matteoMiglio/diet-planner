CREATE TABLE "food" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"source_ref" text,
	"barcode" text,
	"name" text NOT NULL,
	"brand" text,
	"kcal" numeric(6, 1) NOT NULL,
	"protein_g" numeric(5, 1) NOT NULL,
	"carbs_g" numeric(5, 1) NOT NULL,
	"fat_g" numeric(5, 1) NOT NULL,
	"fibre_g" numeric(5, 1),
	"sugar_g" numeric(5, 1),
	"sat_fat_g" numeric(5, 1),
	"salt_g" numeric(5, 2),
	"basis" text DEFAULT 'as_sold' NOT NULL,
	"units" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_source_check" CHECK ("food"."source" in ('custom', 'off', 'opennutrition')),
	CONSTRAINT "food_basis_check" CHECK ("food"."basis" in ('raw', 'dry', 'cooked', 'drained', 'as_sold')),
	CONSTRAINT "food_macros_check" CHECK ("food"."kcal" >= 0 and "food"."protein_g" >= 0 and "food"."carbs_g" >= 0 and "food"."fat_g" >= 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_estimate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"kcal" integer NOT NULL,
	"method" text NOT NULL,
	"inputs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phase_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text DEFAULT 'manual' NOT NULL,
	"document" jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_status_check" CHECK ("meal_plan"."status" in ('draft', 'active', 'archived')),
	CONSTRAINT "meal_plan_created_by_check" CHECK ("meal_plan"."created_by" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "phase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"rate_band_low_kg_per_week" numeric(4, 2),
	"rate_band_high_kg_per_week" numeric(4, 2),
	"target_weight_kg" numeric(5, 2),
	"hold_band_kg" numeric(3, 2) DEFAULT 0.5 NOT NULL,
	"surplus_pct" numeric(4, 3),
	"deficit_rate_pct_per_week" numeric(5, 4),
	"review_every_days" integer DEFAULT 21 NOT NULL,
	"intent" text,
	"post_mortem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phase_type_check" CHECK ("phase"."type" in ('cut', 'maintenance', 'surplus', 'maingain', 'recomp')),
	CONSTRAINT "phase_status_check" CHECK ("phase"."status" in ('active', 'closed')),
	CONSTRAINT "phase_review_days_check" CHECK ("phase"."review_every_days" between 7 and 84)
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"phase_id" uuid,
	"payload" jsonb NOT NULL,
	"reasoning" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_kind_check" CHECK ("proposal"."kind" in ('targets_change', 'diet_break')),
	CONSTRAINT "proposal_status_check" CHECK ("proposal"."status" in ('pending', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"ran_on" date NOT NULL,
	"outcome" text NOT NULL,
	"explanation" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"training_kcal" integer NOT NULL,
	"training_protein_g" integer NOT NULL,
	"training_fat_g" integer NOT NULL,
	"training_carbs_g" integer NOT NULL,
	"training_fibre_g" integer NOT NULL,
	"rest_kcal" integer NOT NULL,
	"rest_protein_g" integer NOT NULL,
	"rest_fat_g" integer NOT NULL,
	"rest_carbs_g" integer NOT NULL,
	"rest_fibre_g" integer NOT NULL,
	"carb_change_g" integer DEFAULT 0 NOT NULL,
	"reasoning" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "targets_phase_version_unique" UNIQUE("phase_id","version"),
	CONSTRAINT "targets_created_by_check" CHECK ("targets"."created_by" in ('engine', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "food" ADD CONSTRAINT "food_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_estimate" ADD CONSTRAINT "maintenance_estimate_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan" ADD CONSTRAINT "meal_plan_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan" ADD CONSTRAINT "meal_plan_phase_id_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phase"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase" ADD CONSTRAINT "phase_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_phase_id_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phase"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_phase_id_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phase"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_phase_id_phase_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phase"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_user_name_idx" ON "food" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_one_active" ON "meal_plan" USING btree ("user_id") WHERE "meal_plan"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "phase_one_active" ON "phase" USING btree ("user_id") WHERE "phase"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_one_pending_per_kind" ON "proposal" USING btree ("user_id","kind") WHERE "proposal"."status" = 'pending';