CREATE TABLE session_stats (
  session_id           integer PRIMARY KEY
                         REFERENCES sessions(id) ON DELETE CASCADE,
  model                varchar,
  input_tokens         bigint  NOT NULL DEFAULT 0,
  output_tokens        bigint  NOT NULL DEFAULT 0,
  cache_read_tokens    bigint  NOT NULL DEFAULT 0,
  cache_write_tokens   bigint  NOT NULL DEFAULT 0,
  work_time_ms         bigint  NOT NULL DEFAULT 0,
  code_files           integer NOT NULL DEFAULT 0,
  code_bytes           bigint  NOT NULL DEFAULT 0,
  doc_files            integer NOT NULL DEFAULT 0,
  doc_bytes            bigint  NOT NULL DEFAULT 0,
  files_edited_written integer NOT NULL DEFAULT 0,
  lines_changed        integer NOT NULL DEFAULT 0,
  image_count          integer NOT NULL DEFAULT 0,
  image_total_bytes    bigint  NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
