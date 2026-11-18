-- The commit a workstream started from (the workspace's base branch tip when it was opened).
-- "Bring into main" bundles <base_commit>..<branch>: the workstream's own copy of the base branch
-- can be moved by the agent, the recorded commit cannot.
ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS base_commit text;

COMMENT ON COLUMN workstreams.base_commit IS 'Commit of base_branch in the workspace repo when the workstream was opened; start of the range brought into main. Null for workstreams opened before 0003 (then the whole branch is bundled).';
