-- T-93 follow-up: distinguish project-authored skills from plugin-authored ones in the
-- Harness Usage report. `source` is meaningful only for kind='skill' rows: 'project'
-- (.claude/skills/) | 'plugin' (~/.claude/plugins/) | NULL (older hook never reported it,
-- or not a skill row). No default/backfill: existing rows read NULL until their next
-- self-report, same as every other nullable capability column on this table.
ALTER TABLE harness_elements
  ADD COLUMN IF NOT EXISTS source varchar(16);
