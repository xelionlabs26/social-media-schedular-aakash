ALTER TABLE "app_settings" ALTER COLUMN "ai_model" SET DEFAULT 'claude-sonnet-5-5';--> statement-breakpoint
UPDATE "app_settings" SET "ai_model" = 'claude-sonnet-5-5' WHERE "ai_model" = 'claude-opus-5-5';
