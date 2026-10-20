-- export_import_jobs.id was originally VARCHAR(36) (a bare UUID's length), but
-- staged_upload rows key this column by the staged file's own generated name —
-- `randomUUID() + '.zip'`, 40 characters — not a bare UUID (Design Decision 5
-- of T-69's export/import feature). Widen to 64 for headroom.
ALTER TABLE export_import_jobs ALTER COLUMN id TYPE VARCHAR(64);
