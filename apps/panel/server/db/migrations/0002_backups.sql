CREATE TYPE "public"."backup_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_target_type" AS ENUM('local', 's3', 'sftp');--> statement-breakpoint
CREATE TABLE "backup_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "backup_target_type" NOT NULL,
	"config" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_targets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"node_id" uuid,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"ignore" text[] DEFAULT '{}'::text[] NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"restoring" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_by_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "backup_limit" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "backup_target_id" uuid;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_target_id_backup_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_targets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_server_idx" ON "backups" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backups_one_pending" ON "backups" USING btree ("server_id") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_backup_target_id_backup_targets_id_fk" FOREIGN KEY ("backup_target_id") REFERENCES "public"."backup_targets"("id") ON DELETE set null ON UPDATE no action;