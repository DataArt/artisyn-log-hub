-- 1a. Replace unique index with unique constraint (R2)
DROP INDEX IF EXISTS "repositories_user_id_repo_url_unique";
ALTER TABLE "repositories"
  ADD CONSTRAINT "repositories_user_id_repo_url_unique"
  UNIQUE ("user_id", "repo_url");

-- 1b. Truncate all log-related tables (R3) — must happen BEFORE ALTER NOT NULL
TRUNCATE TABLE
  "log_repositories",
  "log_contexts",
  "logs",
  "sessions",
  "contexts",
  "repositories"
CASCADE;

-- 1c. Make repositories.user_id NOT NULL + ON DELETE CASCADE (R4)
ALTER TABLE "repositories"
  DROP CONSTRAINT "repositories_user_id_fkey",
  ALTER COLUMN "user_id" SET NOT NULL,
  ADD CONSTRAINT "repositories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- 1d. Make logs.user_id NOT NULL + ON DELETE CASCADE (R4)
ALTER TABLE "logs"
  DROP CONSTRAINT IF EXISTS "logs_user_id_fkey",
  ALTER COLUMN "user_id" SET NOT NULL,
  ADD CONSTRAINT "logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- 1e. Add ON DELETE CASCADE to log_repositories.repo_id FK (R4)
ALTER TABLE "log_repositories"
  DROP CONSTRAINT "log_repositories_repo_id_fkey",
  ADD CONSTRAINT "log_repositories_repo_id_fkey"
    FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
