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

// ---------------------------------------------------------------------------------------------
// OKF usage (2026-11-21 OKF tab minimal) — shared by F19 (session route) and F21 (repo route).
// Written from docs/knowledgebase/algorithms/okf-usage-counting.md, one metric at a time.
// ---------------------------------------------------------------------------------------------

/**
 * CTEs of the KB read rows of a `tree` CTE (its `id` = `sessions.id`; `unitCol` = the column
 * that is the counting unit — the root on the repo route, the node on the session route).
 *
 * - `okf_acc`: a read row is a `read` / `grep` row under the world's one bundle root `docs/kb`
 *   that passes `keep` (the team filter); `tokens` = `bytes` / 4. The world has no glob path and
 *   no dot-path read, so neither needs a rule here.
 * - `okf_node`: per tree node its KB tokens, the tokens it put into its context
 *   (`input_tokens + cache_write_tokens`) and what that context cost (input + both cache writes
 *   + cache read; NULL when the node has no computed cost).
 * - `okf_reads`: every read row with its cost — the node's KB cost
 *   (`min(1, kbTokens / ctxTokens) × ctxCost`) spread over its rows by tokens; NULL = no cost.
 */
export function okfReadsCtes(unitCol: string, keep = 'true'): string {
  return `
    okf_acc AS (SELECT t.${unitCol} AS unit, t.id AS node_id, a.path_key, a.calls,
                       a.bytes / 4.0 AS tokens
                  FROM tree t JOIN session_okf_access a ON a.session_id = t.id
                 WHERE a.op IN ('read', 'grep') AND a.path_key LIKE 'docs/kb/%'
                   AND (${keep})),
    okf_node AS (SELECT n.node_id, sum(n.tokens) AS kb_tokens,
                        (SELECT ss.input_tokens + ss.cache_write_tokens FROM session_stats ss
                          WHERE ss.session_id = n.node_id) AS ctx_tokens,
                        (SELECT CASE WHEN sc.cost IS NOT NULL
                                     THEN coalesce(sc.cost_input, 0)
                                        + coalesce(sc.cost_cache_write_5m, 0)
                                        + coalesce(sc.cost_cache_write_1h, 0)
                                        + coalesce(sc.cost_cache_read, 0) END
                           FROM session_costs sc WHERE sc.session_id = n.node_id) AS ctx_cost
                   FROM okf_acc n GROUP BY n.node_id),
    okf_reads AS (SELECT a.*,
                         CASE WHEN n.ctx_cost IS NOT NULL AND n.ctx_tokens > 0
                                   AND n.kb_tokens > 0
                              THEN least(1, n.kb_tokens / n.ctx_tokens) * n.ctx_cost
                                   * a.tokens / n.kb_tokens END AS cost
                    FROM okf_acc a JOIN okf_node n ON n.node_id = a.node_id)`;
}

/** SQL: the cost of a set of `okf_reads` rows — NULL only when it has rows and none is priced. */
const OKF_COST_OF_ROWS = `CASE WHEN count(*) > 0 AND count(cost) = 0 THEN NULL
                               ELSE coalesce(sum(cost), 0) END`;

/**
 * The `summary` of an OKF usage response over `okf_reads` and `tree`: units with a read row,
 * `unitsTotalSql` (M), calls, tokens, cost, the calls of rows without a cost, and the spend —
 * Σ `session_costs.cost` over every node of the trees (NULL when none has one).
 */
export function okfSummarySelectSql(unitsTotalSql: string): string {
  return `SELECT (SELECT count(DISTINCT unit) FROM okf_reads) AS units_read,
                 ${unitsTotalSql} AS units_total,
                 (SELECT coalesce(sum(calls), 0) FROM okf_reads) AS reads,
                 (SELECT coalesce(sum(tokens), 0) FROM okf_reads) AS tokens,
                 (SELECT ${OKF_COST_OF_ROWS} FROM okf_reads) AS cost,
                 (SELECT coalesce(sum(calls), 0) FROM okf_reads
                   WHERE cost IS NULL) AS reads_without_cost,
                 (SELECT sum(sc.cost) FROM tree t
                    JOIN session_costs sc ON sc.session_id = t.id) AS spend`;
}

export const OKF_SUMMARY_FIELDS = {
  unitsRead: { col: 'units_read', as: 'number' },
  unitsTotal: { col: 'units_total', as: 'number' },
  reads: { col: 'reads', as: 'number' },
  tokens: { col: 'tokens', as: 'numeric' },
  cost: { col: 'cost', as: 'numeric' },
  readsWithoutCost: { col: 'reads_without_cost', as: 'number' },
  spend: { col: 'spend', as: 'numeric' },
} as const;

/**
 * SQL: bundle file `f` of bundle `b` is listed — it passes `visible` (the team filter) and has no
 * dot segment below the bundle root (a dot-path is not part of a bundle).
 */
export function okfListedFileSql(visible = 'true'): string {
  return `(${visible}) AND substr(f->>'path', length(b->>'root') + 2) !~ '(^|/)[.]'`;
}

/**
 * The `files` of an OKF usage response: one row per listed file of the snapshot in the `okf_snap`
 * CTE (column `body`), by path, with what `okf_reads` holds for it — a never opened file has
 * zero units, reads, tokens and cost. `index` = a reserved name (`index.md` / `log.md`, any
 * depth, any case). In the world every read row is on a listed file, so nothing is "not in the
 * snapshot".
 */
export function okfFilesSelectSql(visible = 'true'): string {
  const mine = `FROM okf_reads r WHERE r.path_key = f->>'path'`;
  return `SELECT b->>'root' AS bundle, f->>'path' AS path, true AS in_snapshot,
                 lower(regexp_replace(f->>'path', '^.*/', '')) IN ('index.md', 'log.md') AS is_index,
                 (SELECT count(DISTINCT r.unit) ${mine}) AS units,
                 (SELECT coalesce(sum(r.calls), 0) ${mine}) AS reads,
                 (SELECT coalesce(sum(r.tokens), 0) ${mine}) AS tokens,
                 (SELECT ${OKF_COST_OF_ROWS} ${mine}) AS cost
            FROM okf_snap s, jsonb_array_elements(s.body->'bundles') b,
                 jsonb_array_elements(b->'files') f
           WHERE ${okfListedFileSql(visible)}
           ORDER BY (f->>'path') COLLATE "C"`;
}

export const OKF_FILE_FIELDS = {
  bundle: 'bundle',
  path: 'path',
  inSnapshot: 'in_snapshot',
  index: 'is_index',
  units: { col: 'units', as: 'number' },
  reads: { col: 'reads', as: 'number' },
  tokens: { col: 'tokens', as: 'numeric' },
  cost: { col: 'cost', as: 'numeric' },
} as const;
