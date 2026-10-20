CREATE TABLE "logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" varchar(255) NOT NULL,
	"log_type" varchar(50) NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "logs_session_id_log_type_unique" UNIQUE("session_id","log_type")
);
