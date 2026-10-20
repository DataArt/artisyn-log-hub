ALTER TABLE repositories
    ADD COLUMN hook_version varchar(50),
    ADD COLUMN hook_last_activity timestamptz,
    ADD COLUMN hook_log_tail jsonb,
    ADD COLUMN hook_non_uploadable_logs jsonb,
    ADD COLUMN hook_recommendations jsonb;
