CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" varchar(255) NOT NULL,
	CONSTRAINT "sessions_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_url" varchar(4000) NOT NULL,
	CONSTRAINT "repositories_repo_url_unique" UNIQUE("repo_url")
);
--> statement-breakpoint
CREATE TABLE "contexts" (
	"id" serial PRIMARY KEY NOT NULL,
	"context_key" varchar(255) NOT NULL,
	"context_value" varchar(4000) NOT NULL,
	CONSTRAINT "contexts_context_key_context_value_unique" UNIQUE("context_key","context_value")
);
--> statement-breakpoint
INSERT INTO sessions (session_id)
SELECT DISTINCT session_id FROM logs
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE logs ADD COLUMN session_fk integer;
--> statement-breakpoint
UPDATE logs SET session_fk = s.id FROM sessions s WHERE s.session_id = logs.session_id;
--> statement-breakpoint
ALTER TABLE logs DROP CONSTRAINT "logs_session_id_log_type_unique";
--> statement-breakpoint
ALTER TABLE logs DROP COLUMN session_id;
--> statement-breakpoint
ALTER TABLE logs RENAME COLUMN session_fk TO session_id;
--> statement-breakpoint
ALTER TABLE logs ALTER COLUMN session_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE logs ADD CONSTRAINT logs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id);
--> statement-breakpoint
ALTER TABLE logs ADD CONSTRAINT logs_session_id_log_type_unique UNIQUE (session_id, log_type);
--> statement-breakpoint
CREATE TABLE "log_repositories" (
	"log_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	CONSTRAINT "log_repositories_pkey" PRIMARY KEY ("log_id","repo_id"),
	CONSTRAINT "log_repositories_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "logs"("id") ON DELETE CASCADE,
	CONSTRAINT "log_repositories_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id")
);
--> statement-breakpoint
CREATE TABLE "log_contexts" (
	"log_id" integer NOT NULL,
	"context_id" integer NOT NULL,
	CONSTRAINT "log_contexts_pkey" PRIMARY KEY ("log_id","context_id"),
	CONSTRAINT "log_contexts_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "logs"("id") ON DELETE CASCADE,
	CONSTRAINT "log_contexts_context_id_fkey" FOREIGN KEY ("context_id") REFERENCES "contexts"("id")
);
