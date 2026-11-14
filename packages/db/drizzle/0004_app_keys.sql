CREATE TABLE "app_keys" (
	"name" text PRIMARY KEY NOT NULL,
	"value_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
