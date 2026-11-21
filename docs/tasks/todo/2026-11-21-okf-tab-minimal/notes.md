# Notes — 2026-11-21 OKF Tab — Cut Down to Four Clear Views

## 2026-11-21

**Original raw idea (owner, translated):** "I'd rather shrink the feature to something
understandable: versions, wrong format, hot files, and see which files were opened at all — an
explorer. That's it." Plus: "maybe add something super clear of your own" — this became the summary
line (FR-5, proposed by Claude). The KB cost (FR-5a) was also proposed by Claude and accepted by the
owner ("a good idea").

**Critique of the current OKF tabs.** The OKF tabs of local prod (repo `DataArt/artisyn-log-hub`,
session `5f6ab2f1-…` `/adlc-lh:implement-deep 2026-11-19-okf-v03-support`) were reviewed by five
critique agents (newcomer, data auditor, product, visual design, data-pipeline skeptic). Findings:

- The repo tab is ~1850 lines of text (15–20 screens); the useful part ends at the first screen.
  Headings describe the method ("A · verified", "B · heuristic — check by hand"), not the answer;
  jargon (upkeep, routing miss, pointer yield, flood, coarse) is unexplained; one finding
  (`hook-api-versioning.md`) is repeated 3–4 times.
- The numbers contradict each other: six different denominators on one screen (290 / 227 / 177 /
  18 / 8 / 6); "285 of 290 sessions have no OKF analysis yet" while the page computes from them
  (they are analysed by extractor v2/v3, not v4); session tab "5 of 39 agents read the KB" next to
  "7 AGENTS"; tree SESSIONS column ≠ Hot files (upkeep counted in one, not the other); "↻ own edit
  0 B" on almost every row.
- The verdict "Something to fix" likely rests on a false finding: "coarse article" divides by the
  file size in the current snapshot (70.6 KB, taken from a feature branch) while all 6 sessions read
  the 38.6 KB version (`okf-verdict.ts:1016`).
- Section B (dead pointers, searched after reading, routing miss) is mostly noise —
  `application/json`, `try/catch`, raw regexes — and acting on it would make the KB worse.
- Of ~15 metrics only "coarse article" and "always read" drive an action, and both have
  denominator bugs.

**Planned tab drawn with real data.** The planned tab was drawn with real numbers from local prod
(repo `DataArt/artisyn-log-hub`, last 30 days, 306 root sessions, reference snapshot from `main`)
and read by a critic agent; that first drawing counted `read` rows only and was later replaced by
the FR-0 wireframes in `wireframes/`.
Facts of the first drawing: 72 % of the read bytes in `session_okf_access` are `docs/tasks/todo/**` files outside every
bundle; inside bundles the KB was read in 206 of 306 sessions, 155 files, ≈ 2.99M tokens; 140 of
175 snapshot files were opened; 15 read files are not in the snapshot; `index.md` was read in 69
root sessions (91 agents). Critic verdict: makes sense with changes — hot files and the explorer
lead to actions, versions and wrong format say nothing on this repo, the session tab should not be
a copy of the repo tab.

**FR-0 numbers (reads and searches, one bundle per file).** KB read in 233 of 306 sessions,
≈ 3.77M tokens, ≈ $16.42 at the input rate; 154 of 175 snapshot files opened, 21 never opened; 19
read files are not in the snapshot; folder-level searches are ≈ 65K tokens; `index.md` — 166
sessions, 408 reads, ≈ 398K tokens. Session `5f6ab2f1`: 7 of 39 agents, 20 files, ≈ 55.0K tokens,
≈ $0.22.
