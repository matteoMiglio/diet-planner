CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sex" text,
	"birth_date" date,
	"height_cm" numeric(5, 1),
	"timezone" text DEFAULT 'Europe/Rome' NOT NULL,
	"activity_factor" numeric(3, 2) DEFAULT 1.5 NOT NULL,
	"training_weekdays" integer[] DEFAULT '{1,3,5}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_sex_check" CHECK ("profile"."sex" in ('male', 'female')),
	CONSTRAINT "profile_activity_factor_check" CHECK ("profile"."activity_factor" between 1.2 and 2.0),
	CONSTRAINT "profile_training_weekdays_check" CHECK ("profile"."training_weekdays" <@ '{1,2,3,4,5,6,7}')
);
--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;