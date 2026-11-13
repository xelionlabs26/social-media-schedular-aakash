ALTER TABLE "app_settings" ALTER COLUMN "stt_provider" SET DEFAULT 'deepgram';--> statement-breakpoint
UPDATE "app_settings" SET "stt_provider" = 'deepgram' WHERE "stt_provider" = 'openai';
