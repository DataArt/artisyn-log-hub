-- File area (FR-5g): every repo and home volume is a host folder under the data directory.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS files_dir text;
ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS files_dir text;

COMMENT ON COLUMN workspaces.files_dir IS 'Folder of the workspace relative to WORK_HUB_DATA_DIR (users/<email>/<slug>-<id6>), holding repo/, home/ and workspace.json.';
COMMENT ON COLUMN workstreams.files_dir IS 'Folder of the workstream relative to WORK_HUB_DATA_DIR (<workspace folder>/workstreams/<slug>-<id6>), holding repo/, home/ and workstream.json.';
