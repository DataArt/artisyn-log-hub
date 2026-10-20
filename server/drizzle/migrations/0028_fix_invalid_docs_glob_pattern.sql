-- One-time data fix: TEAM_CREATION_DEFAULT_CONFIG (server/src/teams/teams.service.ts) previously
-- seeded newly-linked team repo_config rows with an invalid glob pattern ('**/*.md') for the
-- default "docs" file category. classifyFile() (server/src/logs/claude-extractor.ts) treats
-- patterns as JavaScript regex strings, and `new RegExp('**/*.md')` throws a SyntaxError, which
-- surfaced as failed rows in the async upload queue for any session under an affected repo.
-- Replace that exact bad literal with its valid regex equivalent (\.md$) wherever it appears
-- inside any category's patterns array. Idempotent: rows without the bad pattern are untouched,
-- and re-running after the fix is a no-op since the WHERE clause no longer matches.
UPDATE repo_config
SET config = jsonb_set(
      config,
      '{fileCategories}',
      (
        SELECT jsonb_agg(
          jsonb_set(
            cat,
            '{patterns}',
            (
              SELECT jsonb_agg(
                CASE WHEN pat = '"**/*.md"'::jsonb THEN '"\\.md$"'::jsonb ELSE pat END
              )
              FROM jsonb_array_elements(cat -> 'patterns') AS pat
            )
          )
        )
        FROM jsonb_array_elements(config -> 'fileCategories') AS cat
      )
    ),
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(config -> 'fileCategories') AS cat
  WHERE cat -> 'patterns' @> '["**/*.md"]'::jsonb
);
