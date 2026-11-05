CREATE TABLE "ai_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"plan_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(8, 4) DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_run_kind_check" CHECK ("ai_run"."kind" in ('generate_plan')),
	CONSTRAINT "ai_run_status_check" CHECK ("ai_run"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"text" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "in_pool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "role" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "preferred_slots" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "portion" jsonb DEFAULT '{"kind":"flexible","stepG":5}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_plan_id_meal_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."meal_plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_run_one_active" ON "ai_run" USING btree ("user_id") WHERE "ai_run"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "food" ADD CONSTRAINT "food_role_check" CHECK ("food"."role" in ('main_protein', 'main_carb', 'fat', 'veg', 'fruit', 'dairy_protein', 'snack', 'other'));--> statement-breakpoint
ALTER TABLE "food" ADD CONSTRAINT "food_priority_check" CHECK ("food"."priority" in ('high', 'medium', 'low'));