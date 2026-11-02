-- Schema documentation: COMMENT ON TABLE for every table and COMMENT ON COLUMN where a column's
-- meaning is not obvious from its name and type (discriminators, units, what NULL means,
-- denormalised caches, soft-delete flags, legacy columns). `npm run db:state` renders these
-- comments into docs/knowledgebase/db_state.sql, the generated current-state DDL.
--
-- Metadata only: no table, column, constraint, index or row changes. Older server builds ignore
-- comments. Re-runnable: COMMENT ON replaces any previous text. Every table named here exists
-- after migration 0083. The auth_sessions table is created by connect-pg-simple at runtime, not by
-- a migration, so it is not commented here.
--
-- Rollback: not needed (COMMENT ON ... IS NULL removes a comment).

-- ── Identity and auth ────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE users IS 'Log Hub accounts; written by UsersService (sign-up, identify, admin) and by import, which creates placeholder owners by email.';
COMMENT ON COLUMN users.password_hash IS 'NULL for accounts without a password (identify-only or not yet confirmed); imported placeholder users hold a sentinel hash that can never log in.';
COMMENT ON COLUMN users.email_confirmed_at IS 'NULL = email not confirmed yet (only meaningful in auth modes that require confirmation).';

COMMENT ON TABLE user_settings IS 'Generic per-user key/value settings owned by the client; the server never interprets names or values. Written by UserSettingsService.';
COMMENT ON COLUMN user_settings.setting_value IS 'Opaque to the server (often JSON); capped at 64 KB by the DTO.';

COMMENT ON TABLE password_reset_tokens IS 'One-time password-reset tokens (1 h TTL); written by PasswordResetTokensService. Rows are marked used, never deleted.';
COMMENT ON COLUMN password_reset_tokens.used_at IS 'Set when the token is consumed or invalidated by a newer token; NULL = still usable until expires_at.';

COMMENT ON TABLE email_confirmation_tokens IS 'One-time email-confirmation tokens (24 h TTL); written by EmailConfirmationTokensService. Rows are marked consumed, never deleted.';
COMMENT ON COLUMN email_confirmation_tokens.consumed_at IS 'Set when the token is consumed or invalidated by a newer token; NULL = still usable until expires_at.';

COMMENT ON TABLE api_keys IS 'Per-user API keys used by the hook; written by ApiKeysService. Only the hash is stored.';
COMMENT ON COLUMN api_keys.slug IS 'Short plaintext prefix of the key, used to find the row before the hash is checked.';
COMMENT ON COLUMN api_keys.expires_at IS 'NULL = never expires.';

COMMENT ON TABLE server_secrets IS 'Server-generated secrets shared by all cluster workers (today only session_secret, used when SESSION_SECRET is empty); written once by resolveSessionSecret() at startup.';

-- ── Teams and access ─────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE teams IS 'Teams; written by TeamsService. Deleting the owner is blocked (owner_id ON DELETE RESTRICT); account deletion handles owned teams first.';
COMMENT ON COLUMN teams.access_mode IS 'transparent = every member sees every member session; restricted = visibility follows team_members.is_manager / is_adlc_trainer.';

COMMENT ON TABLE team_members IS 'Team membership and per-member roles; written by TeamsService.';
COMMENT ON COLUMN team_members.is_manager IS 'Restricted mode only: full-team analytics and every member session, but never prompt text.';
COMMENT ON COLUMN team_members.is_adlc_trainer IS 'Restricted mode only: every member session with prompts, but no analytics or reports.';
COMMENT ON COLUMN team_members.disclosure_acknowledged_at IS 'NULL = member has not acknowledged the access-mode disclosure and is hidden from owner and trainer views.';

COMMENT ON TABLE team_repositories IS 'Repository URLs linked to a team (by URL, not by repositories row); written by TeamsService, AdminService and the repo URL backfill. Owns team_repo_config, team_repo_tool_monitor_config and team_repo_recompute_queue.';

COMMENT ON TABLE team_repo_recompute_queue IS 'Pending team-scope stats recompute after a repository is added to a team; drained by TeamRepoRecomputeService, row deleted on success.';
COMMENT ON COLUMN team_repo_recompute_queue.status IS 'pending | processing | failed (failed = gave up after the retry limit, see last_error).';

COMMENT ON TABLE invitations IS 'Team invitations; written by TeamsService. At most one pending invitation per (team_id, invitee_id).';
COMMENT ON COLUMN invitations.status IS 'pending | accepted | declined | cancelled (only pending rows are unique per team and invitee).';

-- ── Repositories and configuration ───────────────────────────────────────────────────────────

COMMENT ON TABLE repositories IS 'One row per (user, canonical repo URL) the user uploaded sessions from; created by LogsService ingest, also holds the latest hook self-report.';
COMMENT ON COLUMN repositories.repo_url IS 'Canonical URL from normalizeRepoUrl(); a repository without a git remote stores "<owner email>/<path>".';
COMMENT ON COLUMN repositories.max_upload_bytes IS 'Largest single artisyn upload body seen, in bytes; NULL until the first artisyn upload.';
COMMENT ON COLUMN repositories.hook_version IS 'Hook version from the latest hook-status event; NULL = no hook has reported for this repository.';
COMMENT ON COLUMN repositories.hook_log_tail IS 'Last hook.log lines as of the latest report (string array), replaced on every report.';
COMMENT ON COLUMN repositories.harness_inventory_reported_at IS 'Time of the latest artisyn upload carrying a harness inventory self-report; NULL = never reported. Elements with an older last_seen are shown as removed.';
COMMENT ON COLUMN repositories.harness_mcp_per_tool_supported IS 'Whether the latest capable hook could probe MCP tools/list per tool; NULL = never reported by a capable hook.';
COMMENT ON COLUMN repositories.tool_wrap_status IS 'Latest CLI tool-wrapper status reported by the hook (written by the tool-usage rebuild, newest reportedAt wins); NULL = never reported.';

COMMENT ON TABLE repo_config IS 'Personal analysis config (file categories, cache threshold, turn-end advisor) of one user for one repository row; written by RepositoriesService settings save.';
COMMENT ON COLUMN repo_config.config IS 'RepoConfigJson; absent fields fall back to the team config, then to built-in defaults.';

COMMENT ON TABLE team_repo_config IS 'Team analysis config of one team repository link (includes session attribution definitions); written via team-repo-config.ts. No row = team uses defaults.';

COMMENT ON TABLE repo_tool_monitor_config IS 'Personal list of monitored CLI tools for one repository row; written by ToolMonitorConfigService. No row = empty list.';
COMMENT ON TABLE team_repo_tool_monitor_config IS 'Team list of monitored CLI tools for one team repository link; written by ToolMonitorConfigService (team owner only).';

COMMENT ON TABLE harness_elements IS 'Inventory of harness elements (skills, rules, MCP servers, tools) a repository has reported; upserted by harness-elements-writer.ts on artisyn ingest, never derived from usage.';
COMMENT ON COLUMN harness_elements.kind IS 'skill | rule | mcp | tool.';
COMMENT ON COLUMN harness_elements.source IS 'Skills only: project (.claude/skills) | plugin; NULL = older hook did not report it.';
COMMENT ON COLUMN harness_elements.schema_size_tokens IS 'MCP-sourced tools only: estimated tool schema size in tokens (bytes / 4).';
COMMENT ON COLUMN harness_elements.first_seen IS 'NULL for built-in tool rows, which are seeded and never removed.';
COMMENT ON COLUMN harness_elements.last_seen IS 'Bumped on every re-report, never cleared; older than repositories.harness_inventory_reported_at = removed.';

COMMENT ON TABLE repo_code_inventory IS 'History of repository code-size snapshots from the hook code-inventory event (denominator of "share of codebase touched"); written by repo-code-inventory.ts, pruned to the newest rows per repository.';
COMMENT ON COLUMN repo_code_inventory.branch IS 'Empty string when unknown (never NULL, so the unique key stays idempotent).';

-- ── Sessions and logs ────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE sessions IS 'One row per Claude Code session or sub-agent session id; created by LogsService ingest, soft-deleted and purged by SessionsService.';
COMMENT ON COLUMN sessions.parent_session_id IS 'session_id string of the immediate parent session or agent (not always the root); NULL = root session. No FK.';
COMMENT ON COLUMN sessions.workflow_run_id IS 'Workflow run folder name (wf_...) that spawned this sub-agent; NULL otherwise. No FK.';
COMMENT ON COLUMN sessions.deleted IS 'Soft-delete flag: child data is purged, the row stays so re-uploads are rejected and the audit trail resolves.';
COMMENT ON COLUMN sessions.harness_snapshot_id IS 'snapshot_id of the owner harness_snapshots row this session is bound to; set once, never overwritten; NULL = none yet. No FK.';
COMMENT ON COLUMN sessions.okf_snapshot_id IS 'snapshot_id of the owner okf_snapshots row this root session is bound to; set once; NULL for sub-agents and older hooks. No FK.';
COMMENT ON COLUMN sessions.tool_usage_version IS 'NULL = session_tool_usage rows pending rebuild by the background drain; otherwise the extractor version they were built with.';

COMMENT ON TABLE logs IS 'One uploaded log per (session_id, log_type), the raw event lines in body; upserted by LogsService ingest and import.';
COMMENT ON COLUMN logs.log_type IS 'artisyn (hook events) | claude (transcript) | claude-subagent (sub-agent transcript) | claude-otel (normalised OTEL result) | tool-calls (CLI tool wrapper records).';
COMMENT ON COLUMN logs.body IS 'JSON array of the uploaded lines; for claude-otel a normalised summary, not raw OTLP.';
COMMENT ON COLUMN logs.first_prompt IS 'Extracted at write time from artisyn logs only; NULL for other log types (same for start_time, end_time, git_branch, git_repo_root, git_worktree_root).';
COMMENT ON COLUMN logs.start_time IS 'Earliest activity timestamp of an artisyn log (synthetic non-activity lines skipped).';
COMMENT ON COLUMN logs.end_time IS 'Latest activity timestamp of an artisyn log (synthetic non-activity lines skipped).';
COMMENT ON COLUMN logs.git_repo_root IS 'Primary checkout root (git --git-common-dir) of the machine the session ran on; artisyn only.';
COMMENT ON COLUMN logs.git_worktree_root IS 'git rev-parse --show-toplevel of the session, differs from git_repo_root inside a linked worktree; artisyn only.';

COMMENT ON TABLE log_repositories IS 'Links a log (in practice the artisyn log of a root session) to the repositories rows it belongs to; written by LogsService ingest and the repo URL backfill.';
COMMENT ON TABLE contexts IS 'Distinct context key/value pairs found in artisyn event lines; written by LogsService ingest, orphans deleted on session purge.';
COMMENT ON TABLE log_contexts IS 'Links a log to its context pairs; written by LogsService ingest for newly inserted artisyn logs.';
COMMENT ON TABLE user_favorite_sessions IS 'Sessions a user starred; written by RepositoriesService.';

COMMENT ON TABLE deleted_session_log IS 'Audit trail, one row per deleted session ever; written by SessionsService before purge. No FKs: the session may already be gone.';
COMMENT ON COLUMN deleted_session_log.session_pk IS 'sessions.id of the deleted session; unique, also the claim that keeps concurrent retention purges idempotent.';
COMMENT ON COLUMN deleted_session_log.deleted_by_user_id IS 'NULL = removed by the automatic retention purge, not by a user.';
COMMENT ON COLUMN deleted_session_log.total_cost IS 'Computed tree cost in USD at deletion time; NULL = unpriced.';

COMMENT ON TABLE harness_snapshots IS 'Hook-built harness snapshot bodies (skills, agents, MCP servers, system context), one per (owner, snapshot_id); inserted by harness-snapshot.ts on ingest, deleted when no session references the id.';
COMMENT ON COLUMN harness_snapshots.snapshot_id IS 'Hook-computed content hash (64 hex); validated, never recomputed. The same id may exist under several owners.';

COMMENT ON TABLE okf_snapshots IS 'Hook-built OKF knowledge-base snapshot bodies, one per (owner, snapshot_id); inserted by okf-snapshot.ts on ingest, deleted when no session references the id.';
COMMENT ON COLUMN okf_snapshots.snapshot_id IS 'Hook-computed content hash (64 hex); validated, never recomputed.';

-- ── Per-session derived data ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE session_stats IS 'Pre-computed per-session metrics (tokens, work time, edits, list flags, OTEL status); one row per session node, written by session-stats-writer.ts on ingest, import and recompute.';
COMMENT ON COLUMN session_stats.model IS 'Model of the session transcript (may carry a -YYYYMMDD suffix).';
COMMENT ON COLUMN session_stats.cache_write_tokens IS 'Total cache-creation tokens = cache_write_5m_tokens + cache_write_1h_tokens.';
COMMENT ON COLUMN session_stats.web_search_requests IS 'Count of server web-search requests; priced per request, not per token.';
COMMENT ON COLUMN session_stats.input_tokens_fast IS 'Subset of input_tokens billed in fast mode (not additional tokens).';
COMMENT ON COLUMN session_stats.output_tokens_fast IS 'Subset of output_tokens billed in fast mode (not additional tokens).';
COMMENT ON COLUMN session_stats.work_time_ms IS 'Active time in ms: per prompt, last assistant reply minus prompt time, summed.';
COMMENT ON COLUMN session_stats.lines_changed IS 'Lines written by Edit/Write (no delta, no removals); differs from the diff-based lines_added / lines_removed.';
COMMENT ON COLUMN session_stats.lines_added IS 'Diff-based added lines over the Edit/Write calls that carried a diff (see diff_lines_covered_calls).';
COMMENT ON COLUMN session_stats.diff_lines_covered_calls IS 'Edit/Write calls that carried a diff; out of diff_lines_total_calls.';
COMMENT ON COLUMN session_stats.telemetry_cost IS 'Denormalised OTEL cost in micro-USD (sum of logs_otel.cost_usd_micros); NULL = no telemetry signal. Written only by upsertSessionTelemetryCost().';
COMMENT ON COLUMN session_stats.cs_changed_files IS 'Own-scope in-repo changed files; NULL = change surface never computed (also cs_folders_touched, cs_outside_repo_files).';
COMMENT ON COLUMN session_stats.cs_computed_at IS 'Set whenever the change-surface extractor ran, including zero changes; NULL = not computed or repo root unknown.';
COMMENT ON COLUMN session_stats.claude_version IS 'Highest Claude Code version on this transcript; readers prefer it over claude_version_otel. NULL = unknown.';
COMMENT ON COLUMN session_stats.claude_version_otel IS 'Highest OTEL service.version seen for the session; only raised. NULL = unknown.';
COMMENT ON COLUMN session_stats.otel_state IS 'Latest hook OTEL status: ok | partial | none | unknown; NULL = never reported.';
COMMENT ON COLUMN session_stats.otel_reason IS 'Why OTEL is missing or partial; NULL when ok or not reported.';
COMMENT ON COLUMN session_stats.main_model IS 'Session-list flag: model of the first main (non-sidechain) assistant line; root transcripts only.';
COMMENT ON COLUMN session_stats.claude_line_count IS 'Line count of the session own claude log; NULL = no claude log or not computed yet.';
COMMENT ON COLUMN session_stats.list_flags_version IS 'Rules version the session-list flags were computed with; NULL = pending for the startup backfill.';

COMMENT ON TABLE session_tool_stats IS 'Per-session, per-tool call counts and durations; rebuilt delete-then-insert by session-tool-stats-writer.ts on transcript ingest.';
COMMENT ON COLUMN session_tool_stats.unresolved IS 'Calls with no result, or rejected, denied or interrupted.';
COMMENT ON COLUMN session_tool_stats.duration_ms_total IS 'Only for computing the mean; concurrent calls overlap, so never show it as total tool time.';
COMMENT ON COLUMN session_tool_stats.duration_ms_histogram IS 'Counts per fixed duration bucket (bounds in tool-stats.ts are append-only).';
COMMENT ON COLUMN session_tool_stats.parallel_batch_calls IS 'Calls issued together with other tool calls in one assistant message.';

COMMENT ON TABLE session_harness_usage IS 'Per-session harness element usage (tools, MCP, skills, rules); tool/MCP rows rebuilt from the transcript, skill/rule rows upserted from the artisyn inventory, by session-harness-usage-writer.ts.';
COMMENT ON COLUMN session_harness_usage.uses IS 'Call count for tool/mcp rows; always 1 for skill/rule rows (loaded into context).';
COMMENT ON COLUMN session_harness_usage.is_initial IS 'Tool rows only: available from session start (not added later by a deferred-tools delta); NULL for other kinds.';

COMMENT ON TABLE session_changed_paths IS 'Per-session changed-path facts, one row per logical file; written by session-changed-paths-writer.ts on transcript ingest, renormalised when the repo root arrives.';
COMMENT ON COLUMN session_changed_paths.path_key IS 'Row identity: case-folded repo-relative path, else the case-folded raw path (truncated to 1024 chars).';
COMMENT ON COLUMN session_changed_paths.raw_path IS 'First raw spelling seen, kept so the path can be renormalised without re-reading the transcript.';
COMMENT ON COLUMN session_changed_paths.rel_path IS 'Repo-relative path in original case; NULL when outside the repo or the repo root is unknown (as are all normalised columns).';
COMMENT ON COLUMN session_changed_paths.file_kind IS 'Fixed taxonomy: source | test | config | docs | other (not the repo_config categories).';
COMMENT ON COLUMN session_changed_paths.outside_repo IS 'true = resolved outside the repository; false with NULL rel_path = repo root never learned.';
COMMENT ON COLUMN session_changed_paths.change_kind IS 'added | modified (deleted is reserved, never written).';

COMMENT ON TABLE session_file_stats IS 'Per-session file reads per repo_config category, one row set per team scope and per user scope; written by session-file-stats-writer.ts.';
COMMENT ON COLUMN session_file_stats.byte_count IS 'Characters (UTF-16 units) of Read results returned into the context, not file size on disk.';
COMMENT ON COLUMN session_file_stats.team_id IS 'Set on team-scoped rows (NULL on user-scoped rows).';
COMMENT ON COLUMN session_file_stats.user_id IS 'Set on user-scoped rows (NULL on team-scoped rows).';

COMMENT ON TABLE session_cause_stats IS 'Per-session cache-creation tokens split by cause (compaction, file re-read, unattributed), per team or user scope; written by session-cause-stats-writer.ts and RepositoriesService recompute.';
COMMENT ON COLUMN session_cause_stats.threshold IS 'High-cache-creation threshold the totals were computed with (a different current threshold = stale row).';
COMMENT ON COLUMN session_cause_stats.team_id IS 'Set on team-scoped rows (NULL on user-scoped rows).';

COMMENT ON TABLE session_okf_access IS 'Knowledge-base (OKF) paths each session node read, searched, listed or wrote; rebuilt delete-then-insert by okf-access-writer.ts.';
COMMENT ON COLUMN session_okf_access.path_key IS 'Repo-relative file path, or a folder ending in / (repo root = /).';
COMMENT ON COLUMN session_okf_access.op IS 'read | grep | list | write.';
COMMENT ON COLUMN session_okf_access.after_own_edit IS 'Read or grep of a path this node had already written.';
COMMENT ON COLUMN session_okf_access.bytes IS 'UTF-8 bytes of tool results attributed to the path; 0 for write.';
COMMENT ON COLUMN session_okf_access.seq IS '1-based rank of the path first access within the node.';

COMMENT ON TABLE session_tool_usage IS 'MCP and CLI tool calls per session node and tool; rebuilt per session tree by the background ToolUsageRebuildService (tool-usage-writer.ts), never written inline by ingest.';
COMMENT ON COLUMN session_tool_usage.channel IS 'mcp | cli.';
COMMENT ON COLUMN session_tool_usage.tool IS 'MCP server name or CLI tool name.';
COMMENT ON COLUMN session_tool_usage.outputs IS 'Captured call text keyed by callId (each part capped); read only by call detail and search.';

COMMENT ON TABLE session_request_ids IS 'Distinct transcript requestIds of a session; rewritten with every session_stats upsert, used to tell utility OTEL calls from transcript calls.';
COMMENT ON TABLE session_call_tokens IS 'Per-call token arrays of a session transcript, input of the per-call tiered cost; rewritten with every session_stats upsert.';
COMMENT ON COLUMN session_call_tokens.calls IS 'Columnar object: each key holds one number per call in first-seen order; a missing key reads as zeros.';

COMMENT ON TABLE session_costs IS 'Stored computed cost of each session and its breakdown, read by every cost surface; written by recomputeSessionCosts (ingest and the stale-row sweeper).';
COMMENT ON COLUMN session_costs.model_id IS 'session_stats.model with any -YYYYMMDD suffix removed.';
COMMENT ON COLUMN session_costs.price_date IS 'Price date of the top ancestor session; selects the model_pricing row in effect.';
COMMENT ON COLUMN session_costs.cost IS 'Total cost in USD; NULL = unpriced (breakdown columns are then NULL too).';
COMMENT ON COLUMN session_costs.cost_tier_delta IS 'Informational: cost minus the same tokens at base rates; never part of the total.';
COMMENT ON COLUMN session_costs.unavailable_reason IS 'unknown-model or NULL.';
COMMENT ON COLUMN session_costs.stale IS 'true = needs recompute (price changed or ancestor price date changed); cleared by the sweeper.';

COMMENT ON TABLE session_attribution IS 'Current AI session attribution values of a session; written only by SessionAttributionService, a higher prompt_watermark replaces the whole row.';
COMMENT ON COLUMN session_attribution.prompt_watermark IS 'User-prompt count the values were evaluated at.';
COMMENT ON COLUMN session_attribution."values" IS 'Attribute values keyed by attribute key, typed by the team attribute definitions.';
COMMENT ON TABLE session_attribution_runs IS 'Append-only log of session attribution evaluations with their own cost; written by SessionAttributionService.';
COMMENT ON COLUMN session_attribution_runs.outcome IS 'applied | ignored_stale | failed.';
COMMENT ON COLUMN session_attribution_runs.invoking_session_id IS 'session_id string of the invoking session, used by the executive summary join; NULL rows are excluded there.';
COMMENT ON TABLE session_prompt_watermark IS 'Latest user-prompt count reported for a session, only ever raised; written by the post-turn-analysis config request.';

COMMENT ON TABLE turn_end_advisor_runs IS 'Append-only log of turn-end cost advisor runs (submitted or failed only); written by TurnEndCostAdvisorService, orphans purged by a scheduler.';
COMMENT ON COLUMN turn_end_advisor_runs.session_id IS 'session_id string of the invoking session, no FK: the session may not be ingested yet.';
COMMENT ON COLUMN turn_end_advisor_runs.user_id IS 'User whose API key recorded the run; reads require it to equal the session owner, NULL never matches.';
COMMENT ON COLUMN turn_end_advisor_runs.outcome IS 'submitted | failed.';

-- ── OTEL ─────────────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE logs_otel IS 'Raw OTEL chunks, one row per receiver file (one inbound OTLP request); upserted by LogsService ingestOtelChunk.';
COMMENT ON COLUMN logs_otel.chunk_key IS 'Receiver file name; unique per session so a re-uploaded chunk replaces its row.';
COMMENT ON COLUMN logs_otel.cost_usd_micros IS 'Chunk cost in micro-USD; NULL = chunk has no api_request records.';
COMMENT ON COLUMN logs_otel.otel_projection_version IS 'NULL = pending OTEL facts projection; -1 = failed (retried at startup); N = projected by version N.';

COMMENT ON TABLE otel_api_calls IS 'One row per OTEL api_request record, used to price utility calls the transcript does not show; written by ingestOtelChunk.';
COMMENT ON COLUMN otel_api_calls.call_key IS 'request_id, or <chunk_key>:<line index> when the record has none.';
COMMENT ON COLUMN otel_api_calls.cache_write_5m_tokens IS 'All OTEL cache-creation tokens (telemetry has no TTL split).';
COMMENT ON COLUMN otel_api_calls.cost_usd_micros IS 'Claude Code reported cost in micro-USD.';

COMMENT ON TABLE otel_calls IS 'OTEL tab facts: one row per api_request call of a root session; written by otel-facts-writer.ts from the realtime channel and the chunk projection.';
COMMENT ON COLUMN otel_calls.session_id IS 'Always the root session; sub-agent calls are told apart by agent_id.';
COMMENT ON COLUMN otel_calls.call_key IS 'request_id, else rec: + sha1 of the record.';
COMMENT ON COLUMN otel_calls.structure IS 'main | subagent | hidden.';
COMMENT ON COLUMN otel_calls.provisional IS 'Classified before the transcript arrived; may be reclassified.';
COMMENT ON COLUMN otel_calls.source_mask IS 'Bit 1 = seen on the realtime channel, bit 2 = seen in an uploaded chunk (confirmed).';
COMMENT ON COLUMN otel_calls.seq IS 'otel_session_state.seq of the write that last changed the row (delta cursor); first_seq = seq at insert.';
COMMENT ON COLUMN otel_calls.change_kind IS 'new | update | confirm | fill | reclass.';

COMMENT ON TABLE otel_spans IS 'OTEL tab facts: one row per trace span of a root session; written by otel-facts-writer.ts.';
COMMENT ON COLUMN otel_spans.attributes IS 'Raw flattened span attributes, or {_truncated, _bytes} when too large.';
COMMENT ON COLUMN otel_spans.rollup_cost_usd_micros IS 'Own cost plus the rollups of all child spans, micro-USD.';

COMMENT ON TABLE otel_cost_buckets IS 'OTEL tab facts: 5-minute UTC cost rollups of otel_calls per root session and dimensions; written by otel-facts-writer.ts. Rows are zeroed, never deleted.';
COMMENT ON COLUMN otel_cost_buckets.query_source IS 'Empty string = unknown (as for model and cc_version).';

COMMENT ON TABLE otel_session_state IS 'Per root session OTEL cursor and lock row every OTEL writer locks first; no row = session has no OTEL data.';
COMMENT ON COLUMN otel_session_state.seq IS 'Per-root write counter, the since= cursor of the OTEL routes.';
COMMENT ON COLUMN otel_session_state.rt_gap_at IS 'Set when realtime batches were lost; cleared once chunks caught up.';

COMMENT ON TABLE otel_reclass_queue IS 'Sessions whose transcript request ids changed and whose root OTEL calls need reclassification; drained by OtelProjectionService.';

-- ── Pricing and versions ─────────────────────────────────────────────────────────────────────

COMMENT ON TABLE model_pricing IS 'Model prices, one row per price version (model_id, effective_from); written by model-pricing-store.ts (daily Anthropic fetch, OpenRouter import, admin). Readers take the newest row with effective_from <= today.';
COMMENT ON COLUMN model_pricing.model_id IS 'Model id without the -YYYYMMDD suffix.';
COMMENT ON COLUMN model_pricing.price_in IS 'USD per million input tokens (price_out, price_cache_r, price_cache_w_5m, price_cache_w_1h likewise).';
COMMENT ON COLUMN model_pricing.price_cache_w IS 'Legacy flat cache-write price (equals the 5m rate); no readers, kept to stay non-destructive.';
COMMENT ON COLUMN model_pricing.price_web_search IS 'USD per web-search request, not per million tokens; 0 for models without server tools.';
COMMENT ON COLUMN model_pricing.chars_per_token IS 'Estimation-only characters per token; NULL = not researched.';
COMMENT ON COLUMN model_pricing.source IS 'anthropic | openrouter | manual | override; the effective row source is the model current source.';
COMMENT ON COLUMN model_pricing.tiers IS 'Prompt-length price tiers ascending by aboveTokens; NULL = no tiers.';

COMMENT ON TABLE model_pricing_meta IS 'Per-model facts outside price versions: first sighting of an unpriced model and the base price hidden under an override; written by unpriced-model-registry.ts and model-pricing-store.ts.';
COMMENT ON COLUMN model_pricing_meta.first_seen_at IS 'When ingest first saw the model without a price; never cleared.';
COMMENT ON COLUMN model_pricing_meta.override_base_source IS 'Source of the base price kept under an active override (override_base_* columns); NULL = no override.';

COMMENT ON TABLE model_pricing_fetch_state IS 'Status of each price source (anthropic, openrouter); the anthropic row is also the cluster claim for the daily fetch.';
COMMENT ON COLUMN model_pricing_fetch_state.last_result IS 'changed | unchanged | failed (anthropic); imported | failed (openrouter).';

COMMENT ON TABLE ai_tool_version IS 'Latest npm stable/latest versions per AI tool (claude-code); written by AiToolVersionsService, last_attempt_at is the cluster fetch claim.';
COMMENT ON COLUMN ai_tool_version.version_map IS '{stable, latest} npm dist-tags; NULL until the first successful fetch.';
COMMENT ON TABLE ai_tool_version_history IS 'Append-only history of distinct {stable, latest} maps per tool; written by AiToolVersionsService.';

-- ── Queues and jobs ──────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE upload_queue IS 'Staged async uploads (/api/v2/logs) waiting for the worker; written by UploadQueueService, processed by UploadQueueSchedulerService, row deleted on success.';
COMMENT ON COLUMN upload_queue.session_id IS 'session_id string sent by the hook; no FK (the session may not exist yet).';
COMMENT ON COLUMN upload_queue.upload_id IS 'Hook-generated id of a chunked upload; NULL for single-request uploads.';
COMMENT ON COLUMN upload_queue.warning_delivered IS 'true once a rejected_foreign_session warning was returned to the hook.';
COMMENT ON COLUMN upload_queue.harness_snapshot_id IS 'Set only when the upload carries a full harness snapshot body, so the id counts as known while the row is in flight. No FK.';
COMMENT ON COLUMN upload_queue.okf_snapshot_id IS 'Set only when the upload carries a full OKF snapshot body, so the id counts as known while the row is in flight. No FK.';
COMMENT ON COLUMN upload_queue.attempts IS 'Processing attempts; transient database errors retry until the limit.';
COMMENT ON COLUMN upload_queue.error_kind IS 'With status failed: server (Log Hub could not process a good file) | file (broken body); NULL on older rows.';

COMMENT ON TABLE upload_queue_measurements IS 'Append-only worker measurements, one per processing attempt, for the admin upload queue stats; written and pruned by UploadQueueSchedulerService.';
COMMENT ON COLUMN upload_queue_measurements.session_id IS 'session_id string; no FK (the session may never have been ingested or is already purged).';
COMMENT ON COLUMN upload_queue_measurements.queue_latency_ms IS 'finished_at minus the queue row received_at.';
COMMENT ON COLUMN upload_queue_measurements.outcome IS 'success | failure.';

COMMENT ON TABLE export_import_jobs IS 'Background session export, import and staged-upload jobs; written by ExportImportJobsService, old terminal rows removed by ExportImportJobCleanupScheduler.';
COMMENT ON COLUMN export_import_jobs.id IS 'App-generated UUID (staged_upload rows: UUID.zip, also the staged file name).';
COMMENT ON COLUMN export_import_jobs.repo_id IS 'NULL for a bootstrap-import staged upload until it is confirmed.';
