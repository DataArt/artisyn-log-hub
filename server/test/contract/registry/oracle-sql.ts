// Hand-written SQL fragments several families share (F17-F21). Written from the documented
// rules (05 §2.2), deliberately NOT copied from the service's CTEs: plain correlated sub-queries,
// one metric at a time. No imports from src/**.

/** `timestamptz` -> the API's ISO form (`2026-01-10T10:31:00.000Z`), for jsonb built in SQL. */
export function isoSql(expr: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * USD cost of ONE session's own tokens (`stats` = a `session_stats` alias), priced with the
 * newest `model_pricing` row in effect today; NULL for a model without a price. Rates are USD per
 * million tokens; 5-minute and 1-hour cache writes have their own rates.
 */
export function ownCostSql(stats: string): string {
  return `(SELECT (${stats}.input_tokens * p.price_in
                 + ${stats}.output_tokens * p.price_out
                 + ${stats}.cache_read_tokens * p.price_cache_r
                 + ${stats}.cache_write_5m_tokens * p.price_cache_w_5m
                 + ${stats}.cache_write_1h_tokens * p.price_cache_w_1h) / 1000000.0
             FROM model_pricing p
            WHERE p.model_id = ${stats}.model AND p.effective_from <= current_date
            ORDER BY p.effective_from DESC
            LIMIT 1)`;
}

/**
 * A root session's cost including its sub-agent (child) sessions (`sessionPk` = a `sessions.id`
 * expression of the outer query). NULL when the root's own model has no price.
 */
export function treeCostSql(sessionPk: string): string {
  return `(SELECT ${ownCostSql('tc_own')}
                  + coalesce((SELECT sum(${ownCostSql('tc_kid')})
                                FROM sessions tc_c
                                JOIN session_stats tc_kid ON tc_kid.session_id = tc_c.id
                               WHERE tc_c.parent_session_id = (SELECT tc_s.session_id
                                                                 FROM sessions tc_s
                                                                WHERE tc_s.id = ${sessionPk})), 0)
             FROM session_stats tc_own WHERE tc_own.session_id = ${sessionPk})`;
}

/**
 * Derived table of the root sessions a repository's session list shows (`repoParam` = `$n` of
 * the repository id): not soft-deleted, not a child, with an artisyn log that carries a first
 * prompt and a claude log, both linked to the repository. Columns: `id`, `session_id`,
 * `workflow_run_id`, and from the artisyn log `first_prompt`, `start_time`, `end_time`,
 * `git_branch`, `user_id`. Use as `FROM ${listedRootsSql('$1')} r`.
 */
export function listedRootsSql(repoParam: string): string {
  return `(SELECT s.id, s.session_id, s.workflow_run_id, a.first_prompt, a.start_time, a.end_time,
                  a.git_branch, a.user_id
             FROM sessions s
             JOIN logs a ON a.session_id = s.id AND a.log_type = 'artisyn'
                        AND a.first_prompt IS NOT NULL
             JOIN log_repositories la ON la.log_id = a.id AND la.repo_id = ${repoParam}
            WHERE NOT s.deleted
              AND s.parent_session_id IS NULL
              AND EXISTS (SELECT 1 FROM logs c JOIN log_repositories lc ON lc.log_id = c.id
                           WHERE c.session_id = s.id AND c.log_type = 'claude'
                             AND lc.repo_id = ${repoParam}))`;
}
