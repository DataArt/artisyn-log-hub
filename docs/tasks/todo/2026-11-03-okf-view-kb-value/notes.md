# Notes — 2026-11-03-okf-view-kb-value

## 2026-11-03 — Probe evidence (moved from requirements.md)

All signals in requirements.md were checked against a regex probe over this repo's own transcripts
(213 root sessions / 1188 agent transcripts, 2026-10-20 … 11-03). The probe's numbers are
approximate, but they showed which variants of each signal produce a readable list and which
produce noise — the FR rules are the variants that survived. The `real-*` wireframes use these
numbers.

- Probe (approximate, regex-based, not the OKF extractor): `kb-probe*.mjs` in the 2026-11-03
  session scratchpad, over `~/.claude/projects/` transcripts of this repo. Key numbers: 1799 KB
  calls; 52 % of KB `Read` calls ranged (277 of 535), plus 408 `sed -n` calls; 53 % of KB reads
  return pointers; 25 % of pointers seen before the read; yield ≈ 39–41 % (reads with new
  pointers as denominator); 23 % of pointers are folders; pointers per article: 361 in one, 124
  in two, 51 in three, 85 in four or more (`pointerMaxArticles` = 3 keeps 86 %); routing-miss
  pairs: 6186 unfiltered → ≈ 180–210 with the FR-3 rules (`routingMinSearches` 2 → 594 pairs /
  47 articles, 3 → 206 / 27, 4 → 110 / 14); dead pointers at `deadPointerMinShown` 4: 50 dead /
  106 followed; 19 of 1799 KB results are `<persisted-output>`; some `cat`/`Read` results are
  2 bytes (empty).
- Upkeep: ≈ 26 % of KB-reading agents edit the same article; the strongest "article did not
  answer" signal (`server-endpoint-map.md`, `UseGuards` ×12) came entirely from the agent that
  was slimming that article.
- Share histogram: a 2-article bundle (`docs/kb-local`) put 22 sessions into "50+".
- Byte split: the even split of a multi-file `cat` credited a 20 KB article with ~1.3 KB.
- Dropped "searches drop after the first KB read" tile: control agents with no KB read at all,
  cut at the same relative point (28 % of calls), search 31 % less afterwards vs 34 % for KB
  readers (halves of the corpus: −27 % / −40 %).
- Dropped per-pointer yield: ≈ 11 %.
- Folder / non-`codeRoots` pointers in the area: the routing-miss list had 6186 pairs and its top
  was `task-checks-guide.md` only because it names `docs/tasks/todo`.
- Earlier evidence (scratch copies, not in git): `okf-instrument-critique.md`,
  `kb-usage-stats.md`, `kb-session-cases.md`. KB used by 101 of 137 real sessions per raw logs vs
  54 of 147 per the OKF tab (no recompute before 2026-10-28) — FR-11; KB is 7.4 % of tool-result
  characters.
- Real findings the probe surfaced (worth acting on in the KB task itself): `test/scenarios.md`
  routing miss (29 of 33 agents searched its area without it); `hook-system-overview.md` paths
  written relative to `hook/.claude/telemetry_tool/` (agents looked for `scripts/hook-log.js`,
  already changed in 582ff31); `algorithms/README.md` 21 dead pointers.
