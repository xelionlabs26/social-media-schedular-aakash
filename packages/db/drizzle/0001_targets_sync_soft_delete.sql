ALTER TABLE "post_targets" ADD COLUMN "needs_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "deleted_at" timestamp with time zone;