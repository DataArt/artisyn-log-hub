CREATE TABLE IF NOT EXISTS deleted_session_log (
  id serial PRIMARY KEY,
  session_id varchar(255) NOT NULL,
  session_pk integer NOT NULL,
  owner_user_id integer,
  deleted_by_user_id integer NOT NULL,
  deleted_at timestamp with time zone NOT NULL DEFAULT now(),
  start_time timestamp with time zone,
  end_time timestamp with time zone,
  work_time_ms bigint,
  total_cost numeric(14, 8)
);

CREATE INDEX IF NOT EXISTS deleted_session_log_deleted_by_idx ON deleted_session_log(deleted_by_user_id);
CREATE INDEX IF NOT EXISTS deleted_session_log_deleted_at_idx ON deleted_session_log(deleted_at);
