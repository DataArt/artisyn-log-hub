ALTER TABLE logs
  ADD COLUMN first_prompt  text,
  ADD COLUMN start_time    timestamptz,
  ADD COLUMN end_time      timestamptz,
  ADD COLUMN git_branch    text;
