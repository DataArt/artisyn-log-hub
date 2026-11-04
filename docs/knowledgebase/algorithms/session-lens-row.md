---
reviewed: no
reviewer: none
---

# Session lens row and lens default tab

## Purpose

A session has 21 tabs (the seven charts are plain tabs). The tab bar has **one level** of tabs:
a "View" select (the lens: "Cost", "What happened", ...) puts the few tabs that answer one
question into the single tab row and moves every other tab into "More ▾", under its session group
header, so the user sees a short row and can still reach every tab. The "All tabs" lens puts every
visible tab into the row (what does not fit the width still overflows into More at render time).

## Code

- Implementation: `client/src/viewer/pages/repository/session-lenses.ts` (`LENSES`, `lensRow`,
  `lensDefaultTab`, `groupOf`). The tab groups come from the session rows of the tab registry
  (`client/src/viewer/tab-ids.ts`, `TAB_REGISTRY`, `SESSION_GROUPS`); they are only More-menu
  section headers, not a level of the bar.
- Callers (not part of the rule): `SessionLensRow.tsx` renders `lensRow`, `useSessionLens.ts`
  calls `lensDefaultTab` on a lens switch.
- Twins: none.
- Test: `client/src/viewer/pages/repository/session-lenses.algo.test.ts`.

## Input and output

- `visible` is the list of session tabs the viewer may see, in registry order. The caller drops
  hidden tabs before the call: Advisor without an advisor result, Raw Logs for anyone but the
  session owner. The legacy alias `charts` (an old link, redirected to the last chart) is never
  in it.
- `lensRow(lens, activeTab, visible)` returns `{row, extra, more}`: `row` and `extra` are tabs,
  `extra` may be `null`, `more` is a list of `{group, tabs}`.
- `lensDefaultTab(lens, visible)` returns one tab.

## Rules

### Lenses and groups

The lens table (`LENSES`):

| Lens | Promoted tabs, in this order | Default tab |
|---|---|---|
| `what-happened` | summary, logs, bash, timeline, agent-tree, session-map, change-surface | summary |
| `cost` | summary, usage, call-tree, context-growth, dashboard, advisor, otel | usage |
| `harness` | sysctx, context-usage, harness-usage, okf, info | sysctx |
| `failed-tool` | tools, logs, bash, tool-heatmap, otel | tools |
| `all` | (none: every visible tab) | summary |

The groups, in `SESSION_GROUPS` order, and their tabs in registry order:

| Group | Tabs |
|---|---|
| `overview` | summary, info, usage, advisor, session-map |
| `transcript` | logs, bash, raw-logs |
| `cost-context` | dashboard (label "Dashboard"), context-growth, context-usage, agent-tree, timeline, tool-heatmap, call-tree, sysctx, harness-usage, otel |
| `effects` | change-surface, tools, okf |

### `lensRow`

1. For `all`: `row` = `visible` unchanged, `extra` = `null`, `more` = empty. Stop.
2. `row` = the promoted tabs of the lens that are in `visible`, in the lens order (not the
   registry order).
3. `extra` = `activeTab` when it is in `visible` and not in `row`; otherwise `null`. It is shown
   after a divider at the end of the row.
4. `rest` = the tabs of `visible` that are neither in `row` nor `extra`, in `visible` order.
5. `more` = for each group in `SESSION_GROUPS` order, `{group, tabs}` with the tabs of `rest` that
   belong to that group, in `rest` order. A group with no tabs is dropped.

Every visible tab therefore appears exactly once: in `row`, as `extra`, or in `more`.

### `lensDefaultTab`

1. `tab` = the default tab of the lens (table above).
2. The result is `tab` when it is in `visible`, otherwise `summary`.

## Edge cases

- Every lens with its promoted tabs: Cost LR-01, What happened LR-04, Harness LR-05, Failed tool
  LR-06, All LR-07.
- Hidden Advisor and Raw Logs leave the Cost row and More: LR-02.
- An out-of-lens active tab goes to `extra`, not to More (the `?tab=logs&lens=cost` link): LR-03.
  An out-of-lens chart as `extra`, taken from a group that keeps other tabs in More: LR-10.
- An active tab that is not visible is not `extra`: LR-08. A promoted active tab is not repeated:
  LR-09.
- A group left empty is dropped from More: LR-04, LR-06.
- The row follows the lens order, not the registry order (Info last under Harness, Call Tree
  before the other charts under Cost, Session Map after Agent Tree under What happened): LR-01,
  LR-04, LR-05.
- An overview tab that is not promoted stays in More under overview (Session Map under Cost):
  LR-01.
- Default tab per lens: LD-01 to LD-05. A hidden default falls back to Summary: LD-06.

## Examples

Two kinds of rows; every tab and group is its id string.

- **Row rows** have `input.lensRow`: `{"lens", "active", "visible"}`; `expected` is
  `{"row", "extra", "more"}` with `more` as `[{"group", "tabs"}]`.
- **Default rows** have `input.lensDefaultTab`: `{"lens", "visible"}`; `expected.tab` is the tab.

Rows (16): [`docs/algorithm-examples/session-lens-row.json`](../../algorithm-examples/session-lens-row.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Row in registry order instead of lens order" -> LR-05 (info would come first), LR-01 (call-tree
  would come after context-growth and dashboard), LR-04 (session-map would come before logs).
- "Promoted tabs not intersected with `visible`" -> LR-02 (advisor would stay in the Cost row).
- "Active out-of-lens tab left in More as well as `extra`" -> LR-03, LR-10.
- "`extra` set even when the active tab is hidden" -> LR-08.
- "Empty groups kept in More" -> LR-04, LR-06.
- "Hidden default falls back to the first promoted tab" -> LD-06.

## Where the result is visible

Session view: the "View" select at the start of the tab bar (`session-lens`, value = lens id),
the single tab row (`tab-session-<id>`), the divider before an out-of-lens active tab
(`session-lens-extra`), and the "More ▾" menu (`session-tabs-more`) with its group headers.
Scenarios S-SESS-01, S-SESS-04 and S-NAV-01 walk these.
