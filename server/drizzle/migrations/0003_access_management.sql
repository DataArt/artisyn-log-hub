DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM ('admin', 'user');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" "user_role" NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_repo_url_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_user_id_repo_url_unique" ON "repositories" ("user_id", "repo_url");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar NOT NULL,
  "owner_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "teams_name_unique" UNIQUE("name"),
  CONSTRAINT "teams_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
  "team_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "can_invite" boolean NOT NULL DEFAULT false,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id", "user_id"),
  CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_repositories" (
  "id" serial PRIMARY KEY NOT NULL,
  "team_id" integer NOT NULL,
  "repo_url" varchar(4000) NOT NULL,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_repositories_team_id_repo_url_unique" UNIQUE("team_id", "repo_url"),
  CONSTRAINT "team_repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
  "id" serial PRIMARY KEY NOT NULL,
  "team_id" integer NOT NULL,
  "inviter_id" integer NOT NULL,
  "invitee_id" integer NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id"),
  CONSTRAINT "invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_pending_unique" ON "invitations" ("team_id", "invitee_id") WHERE status = 'pending';
