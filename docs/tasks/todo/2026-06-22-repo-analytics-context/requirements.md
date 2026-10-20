# T-39: Repo Analytics Context Metrics

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-06-22

## Description

add for repo analytics - display type: context. Two sub values. Max context window size; number of context window compactions

## Functional Requirements

- Add a new "Context" display type in the Repo Analytics section alongside existing display types (e.g. cost, tokens, time).
- Under "Context", show two sub-metrics per session or aggregated:
  1. **Max context window size** — the peak context window token count observed across all LLM calls in the session/period.
  2. **Number of context window compactions** — count of times context was compacted (summarized/truncated) during the session/period.

## Acceptance Criteria

- [ ] "Context" appears as a selectable display type in the Repo Analytics UI.
- [ ] Selecting "Context" shows two sub-values: max context window size and compaction count.
- [ ] Both values are derived from existing session log data (no new server-side data collection required if data is already available).
- [ ] Values are displayed consistently with other analytics display types (same formatting conventions).
- [ ] No regressions in existing analytics display types.

## Open Questions

- Is "max context window size" the model's configured context limit or the actual peak usage observed in parsed log data?
- Is compaction count already parsed from logs, or does it need a new parser rule?
- Should these metrics appear per-session in session lists, or only in aggregate repo-level analytics?

## Notes

<!-- Append timestamped notes here as work progresses -->
