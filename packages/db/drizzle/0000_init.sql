CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"field" text,
	"instruction" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"effort" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"request_id" text,
	"output" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"social_account_id" uuid,
	"kind" text NOT NULL,
	"target_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"default_platforms" text[] DEFAULT ARRAY['instagram','youtube','facebook']::text[] NOT NULL,
	"brand_voice" text DEFAULT '' NOT NULL,
	"example_captions" text DEFAULT '' NOT NULL,
	"banned_words" text DEFAULT '' NOT NULL,
	"emoji_level" text DEFAULT 'light' NOT NULL,
	"caption_script" jsonb DEFAULT '{"instagram":"hinglish_roman","youtube":"hinglish_roman","facebook":"hinglish_roman"}'::jsonb NOT NULL,
	"hashtag_counts" jsonb DEFAULT '{"instagram":{"min":3,"max":5},"youtube":{"min":2,"max":3},"facebook":{"min":0,"max":0}}'::jsonb NOT NULL,
	"ai_model" text DEFAULT 'claude-opus-5-5' NOT NULL,
	"ai_effort" text DEFAULT 'low' NOT NULL,
	"stt_provider" text DEFAULT 'openai' NOT NULL,
	"youtube_defaults" jsonb DEFAULT '{"privacy":"public","categoryId":"22","madeForKids":false,"notifySubscribers":true,"syntheticMedia":false,"defaultLanguage":"hi"}'::jsonb NOT NULL,
	"instagram_defaults" jsonb DEFAULT '{"shareToFeed":true}'::jsonb NOT NULL,
	"facebook_defaults" jsonb DEFAULT '{"kind":"auto"}'::jsonb NOT NULL,
	"missed_policy" text DEFAULT 'publish_late_or_ask' NOT NULL,
	"late_grace_minutes" integer DEFAULT 120 NOT NULL,
	"min_gap_minutes" integer DEFAULT 5 NOT NULL,
	"keep_originals" boolean DEFAULT false NOT NULL,
	"purge_after_days" integer DEFAULT 7 NOT NULL,
	"notify_channel" text DEFAULT 'telegram' NOT NULL,
	"telegram_chat_id" text,
	"notify_email" text,
	"daily_digest" boolean DEFAULT false NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"privacy_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_singleton" CHECK ("app_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"platforms" text[] NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"slot_rule" jsonb DEFAULT '{"mode":"next_free"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"original_key" text NOT NULL,
	"master_key" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"processing_step" text,
	"duration_ms" integer,
	"width" integer,
	"height" integer,
	"rotation" integer,
	"fps" double precision,
	"vcodec" text,
	"acodec" text,
	"has_audio" boolean,
	"color_transfer" text,
	"bitrate" integer,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript" text,
	"transcript_lang" text,
	"transcript_provider" text,
	"transcript_edited" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"cover_frame_ms" integer,
	"error" text,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"t_ms" integer NOT NULL,
	"key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid,
	"channel" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier_enc" text,
	"redirect_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"social_account_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"attention_reason" text,
	"note" text,
	"publish_mode" text,
	"scheduled_at" timestamp with time zone,
	"prepare_at" timestamp with time zone,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"text_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"remote_container_id" text,
	"remote_upload_uri" text,
	"remote_upload_offset" bigint,
	"remote_media_id" text,
	"remote_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekday" smallint NOT NULL,
	"time" text NOT NULL,
	"platforms" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_slots_weekday_range" CHECK ("posting_slots"."weekday" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"batch_id" uuid,
	"scheduled_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"step" text NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer,
	"platform_code" text,
	"message" text,
	"response_excerpt" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"auth_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"user_access_token_enc" text,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"access_expires_at" timestamp with time zone,
	"data_access_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"field" text NOT NULL,
	"pattern" text DEFAULT '' NOT NULL,
	"mode" text DEFAULT 'ai_only' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_target_id_post_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_frames" ADD CONSTRAINT "media_frames_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_id_post_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_target_id_post_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generations_asset" ON "ai_generations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ai_generations_created" ON "ai_generations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_calls_kind_at" ON "api_calls" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "media_assets_status" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_assets_batch" ON "media_assets" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_frames_asset_idx" ON "media_frames" USING btree ("asset_id","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_post_platform" ON "post_targets" USING btree ("post_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_idempotency" ON "post_targets" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "post_targets_status_prepare" ON "post_targets" USING btree ("status","prepare_at");--> statement-breakpoint
CREATE INDEX "post_targets_status_scheduled" ON "post_targets" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_slots_weekday_time" ON "posting_slots" USING btree ("weekday","time");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_asset" ON "posts" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "posts_scheduled" ON "posts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_attempts_target" ON "publish_attempts" USING btree ("target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_external" ON "social_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_platform_field" ON "templates" USING btree ("platform","field");