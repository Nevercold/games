CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "server_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_subusers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_server_prefs" (
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"group_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"color" text,
	CONSTRAINT "user_server_prefs_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "status_message" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "primary_allocation_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "server_groups" ADD CONSTRAINT "server_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_subusers" ADD CONSTRAINT "server_subusers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_subusers" ADD CONSTRAINT "server_subusers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_prefs" ADD CONSTRAINT "user_server_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_prefs" ADD CONSTRAINT "user_server_prefs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_prefs" ADD CONSTRAINT "user_server_prefs_group_id_server_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."server_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_groups_user_idx" ON "server_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "server_subusers_server_user_unique" ON "server_subusers" USING btree ("server_id","user_id");--> statement-breakpoint
CREATE INDEX "server_subusers_user_idx" ON "server_subusers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: existing servers use their lowest assigned port as primary allocation.
UPDATE "servers" s SET "primary_allocation_id" = (
	SELECT a."id" FROM "allocations" a WHERE a."server_id" = s."id" ORDER BY a."port" LIMIT 1
) WHERE s."primary_allocation_id" IS NULL;