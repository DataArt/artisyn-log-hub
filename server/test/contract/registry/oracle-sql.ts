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
 * FR-6 (2026-11-03 otel-cost-attribution): the OTEL cost in USD of one sub-agent (`kid` = its
 * `session_stats` alias, `kidSessionId` = its `sessions.session_id` expression, `rootPk` = the
 * root's `sessions.id` expression), or NULL. Only a sub-agent of Claude Code before 2.1.307
 * (whose transcript can miss calls) has one: the root's `otel_calls` whose `agent_id`, prefixed
 * with `agent-`, is the sub-agent's session id. The version is the transcript's, else OTEL's.
 */
export function subagentOtelUsdSql(
  kid: string,
  kidSessionId: string,
  rootPk: string,
): string {
  const version = `coalesce(nullif(${kid}.claude_version, ''), ${kid}.claude_version_otel)`;
  return `(CASE WHEN string_to_array(substring(${version} from '^[0-9]+[.][0-9]+[.][0-9]+'), '.')::int[]
                     < '{2,1,307}'::int[]
                THEN (SELECT sum(so.cost_usd_micros) / 1000000.0 FROM otel_calls so
                       WHERE so.session_id = ${rootPk}
                         AND 'agent-' || so.agent_id = ${kidSessionId})
           END)`;
}

/**
 * {@link treeCostSql} with FR-6: a sub-agent that has an OTEL cost ({@link subagentOtelUsdSql})
 * counts with the larger of its transcript cost and that OTEL cost.
 */
export function treeCostWithOtelSubagentsSql(sessionPk: string): string {
  return `(SELECT ${ownCostSql('fr6_own')}
                  + coalesce((SELECT sum(CASE WHEN fr6_o.usd IS NULL THEN ${ownCostSql('fr6_kid')}
                                              ELSE greatest(coalesce(${ownCostSql('fr6_kid')}, 0), fr6_o.usd)
                                         END)
                                FROM sessions fr6_c
                                JOIN session_stats fr6_kid ON fr6_kid.session_id = fr6_c.id
                                CROSS JOIN LATERAL (SELECT ${subagentOtelUsdSql('fr6_kid', 'fr6_c.session_id', sessionPk)} AS usd) fr6_o
                               WHERE fr6_c.parent_session_id = (SELECT fr6_s.session_id
                                                                  FROM sessions fr6_s
                                                                 WHERE fr6_s.id = ${sessionPk})), 0)
             FROM session_stats fr6_own WHERE fr6_own.session_id = ${sessionPk})`;
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
