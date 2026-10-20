DO $$ BEGIN
  CREATE TYPE team_access_mode AS ENUM ('transparent', 'restricted');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE teams        ADD COLUMN IF NOT EXISTS access_mode team_access_mode NOT NULL DEFAULT 'restricted';
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_manager boolean NOT NULL DEFAULT false;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_adlc_trainer boolean NOT NULL DEFAULT false;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS disclosure_acknowledged_at timestamptz;

-- FR-3 is satisfied by the DEFAULT above: ADD COLUMN stamps every existing row 'restricted',
-- including teams that had allow_member_session_visibility = true. No separate UPDATE — an
-- unconditional one would silently revert a deliberately-transparent team on any manual re-run.

-- Design Decision 13: pre-existing members count as already disclosed, otherwise AC-6 breaks.
UPDATE team_members SET disclosure_acknowledged_at = joined_at WHERE disclosure_acknowledged_at IS NULL;

ALTER TABLE teams DROP COLUMN IF EXISTS allow_member_session_visibility;
