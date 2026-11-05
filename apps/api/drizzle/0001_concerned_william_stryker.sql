CREATE TABLE "body_measurement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"weight_kg" numeric(5, 2) NOT NULL,
	"bmi" numeric(4, 1),
	"body_fat_pct" numeric(4, 1),
	"muscle_mass_kg" numeric(5, 2),
	"muscle_quality" numeric(5, 1),
	"bone_mass_kg" numeric(4, 2),
	"visceral_fat" numeric(4, 1),
	"bmr_kcal" integer,
	"metabolic_age" integer,
	"body_water_pct" numeric(4, 1),
	"physique_rating" integer,
	"protocol_ok" boolean NOT NULL,
	"outlier_override" boolean,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "body_measurement_user_time_unique" UNIQUE("user_id","measured_at"),
	CONSTRAINT "body_measurement_source_check" CHECK ("body_measurement"."source" in ('tanita_csv', 'manual', 'shortcut')),
	CONSTRAINT "body_measurement_weight_check" CHECK ("body_measurement"."weight_kg" between 20 and 300)
);
--> statement-breakpoint
CREATE TABLE "checkin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"measurement_id" uuid,
	"girth_id" uuid,
	"adherence" text,
	"training_progressed" text,
	"sleep" smallint,
	"energy" smallint,
	"hunger" smallint,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkin_user_week_unique" UNIQUE("user_id","week_start"),
	CONSTRAINT "checkin_adherence_check" CHECK ("checkin"."adherence" in ('on_plan', 'mostly', 'off')),
	CONSTRAINT "checkin_training_check" CHECK ("checkin"."training_progressed" in ('yes', 'no', 'deload')),
	CONSTRAINT "checkin_sleep_check" CHECK ("checkin"."sleep" between 1 and 5),
	CONSTRAINT "checkin_energy_check" CHECK ("checkin"."energy" between 1 and 5),
	CONSTRAINT "checkin_hunger_check" CHECK ("checkin"."hunger" between 1 and 5),
	CONSTRAINT "checkin_week_start_monday_check" CHECK (extract(isodow from "checkin"."week_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "girth_measurement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"measured_on" date NOT NULL,
	"waist_cm" numeric(5, 1),
	"chest_cm" numeric(5, 1),
	"biceps_cm" numeric(4, 1),
	"quad_cm" numeric(4, 1),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "girth_measurement_user_day_unique" UNIQUE("user_id","measured_on")
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"local_date" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notification_log_once_per_day" UNIQUE("user_id","kind","local_date")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device_label" text,
	"last_success_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "reminders_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "weigh_in_days" integer[] DEFAULT '{1,4}' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "weigh_in_time" text DEFAULT '07:30' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "checkin_reminder_time" text DEFAULT '20:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "body_measurement" ADD CONSTRAINT "body_measurement_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin" ADD CONSTRAINT "checkin_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin" ADD CONSTRAINT "checkin_measurement_id_body_measurement_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public"."body_measurement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin" ADD CONSTRAINT "checkin_girth_id_girth_measurement_id_fk" FOREIGN KEY ("girth_id") REFERENCES "public"."girth_measurement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "girth_measurement" ADD CONSTRAINT "girth_measurement_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "body_measurement_user_time_idx" ON "body_measurement" USING btree ("user_id","measured_at");--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_weigh_in_days_check" CHECK ("profile"."weigh_in_days" <@ '{1,2,3,4,5,6,7}');--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_weigh_in_time_check" CHECK ("profile"."weigh_in_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_checkin_reminder_time_check" CHECK ("profile"."checkin_reminder_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');