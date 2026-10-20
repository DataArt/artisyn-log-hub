CREATE TABLE "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" varchar NOT NULL,
  "password_hash" varchar NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "name" varchar(1000) NOT NULL,
  "slug" varchar(6) NOT NULL,
  "key_hash" varchar NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "api_keys_user_id_name_unique" UNIQUE("user_id","name"),
  CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX ON api_keys (slug);
--> statement-breakpoint
ALTER TABLE logs ADD COLUMN "user_id" integer REFERENCES users(id) ON DELETE SET NULL;
