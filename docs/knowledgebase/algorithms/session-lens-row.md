---
reviewed: no
reviewer: none
---

# Session lens row and lens default tab

## Purpose

A session has 20 tabs (the seven charts are plain tabs). The tab bar has **one level** of tabs:
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
| `what-happened` | summary, logs, bash, timeline, agent-tree, change-surface | summary |
| `cost` | summary, usage, call-tree, context-growth, dashboard, advisor, otel | usage |
| `harness` | sysctx, context-usage, harness-usage, okf, info | sysctx |
| `failed-tool` | tools, logs, bash, tool-heatmap, otel | tools |
| `all` | (none: every visible tab) | summary |

The groups, in `SESSION_GROUPS` order, and their tabs in registry order:

| Group | Tabs |
|---|---|
| `overview` | summary, info, usage, advisor |
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
  before the other charts under Cost): LR-01, LR-05.
- Default tab per lens: LD-01 to LD-05. A hidden default falls back to Summary: LD-06.

## Examples

Two kinds of rows; every tab and group is its id string.

- **Row rows** have `input.lensRow`: `{"lens", "active", "visible"}`; `expected` is
  `{"row", "extra", "more"}` with `more` as `[{"group", "tabs"}]`.
- **Default rows** have `input.lensDefaultTab`: `{"lens", "visible"}`; `expected.tab` is the tab.

```examples
[
  {
    "id": "LR-01",
    "input": {"lensRow": {"lens": "cost", "active": "summary", "visible": ["summary", "info", "usage", "advisor", "logs", "bash", "raw-logs", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "usage", "call-tree", "context-growth", "dashboard", "advisor", "otel"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["info"]},
        {"group": "transcript", "tabs": ["logs", "bash", "raw-logs"]},
        {"group": "cost-context", "tabs": ["context-usage", "agent-tree", "timeline", "tool-heatmap", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "tools", "okf"]}
      ]
    },
    "note": "All 20 tabs visible. Rule 2: all seven Cost tabs are visible, in lens order (call-tree before context-growth and dashboard). Rule 3: summary is in row, extra = null. Rules 4-5: the other 13 tabs by group."
  },
  {
    "id": "LR-02",
    "input": {"lensRow": {"lens": "cost", "active": "summary", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "usage", "call-tree", "context-growth", "dashboard", "otel"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["info"]},
        {"group": "transcript", "tabs": ["logs", "bash"]},
        {"group": "cost-context", "tabs": ["context-usage", "agent-tree", "timeline", "tool-heatmap", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "tools", "okf"]}
      ]
    },
    "note": "Advisor (no advisor result) and Raw Logs (not the owner) are hidden. Rule 2: advisor is dropped from the Cost row. Rule 5: transcript keeps logs, bash only; raw-logs appears nowhere."
  },
  {
    "id": "LR-03",
    "input": {"lensRow": {"lens": "cost", "active": "logs", "visible": ["summary", "info", "usage", "logs", "bash", "raw-logs", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "usage", "call-tree", "context-growth", "dashboard", "otel"],
      "extra": "logs",
      "more": [
        {"group": "overview", "tabs": ["info"]},
        {"group": "transcript", "tabs": ["bash", "raw-logs"]},
        {"group": "cost-context", "tabs": ["context-usage", "agent-tree", "timeline", "tool-heatmap", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "tools", "okf"]}
      ]
    },
    "note": "The ?tab=logs&lens=cost link, no advisor result. Rule 3: logs is visible and not in row, so extra = logs. Rule 4: logs is removed from rest, so transcript in More has bash, raw-logs only."
  },
  {
    "id": "LR-04",
    "input": {"lensRow": {"lens": "what-happened", "active": "summary", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "logs", "bash", "timeline", "agent-tree", "change-surface"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["info", "usage"]},
        {"group": "cost-context", "tabs": ["dashboard", "context-growth", "context-usage", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel"]},
        {"group": "effects", "tabs": ["tools", "okf"]}
      ]
    },
    "note": "Eighteen visible tabs (no advisor, no raw-logs). Rule 2: all six What-happened tabs visible, timeline before agent-tree as listed. Rule 5: transcript has no tab left (logs and bash are in row, raw-logs hidden), so it is dropped."
  },
  {
    "id": "LR-05",
    "input": {"lensRow": {"lens": "harness", "active": "sysctx", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["sysctx", "context-usage", "harness-usage", "okf", "info"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["summary", "usage"]},
        {"group": "transcript", "tabs": ["logs", "bash"]},
        {"group": "cost-context", "tabs": ["dashboard", "context-growth", "agent-tree", "timeline", "tool-heatmap", "call-tree", "otel"]},
        {"group": "effects", "tabs": ["change-surface", "tools"]}
      ]
    },
    "note": "Rule 2: the row keeps the lens order sysctx, context-usage, harness-usage, okf, info; info comes last although it is second in registry order."
  },
  {
    "id": "LR-06",
    "input": {"lensRow": {"lens": "failed-tool", "active": "tools", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["tools", "logs", "bash", "tool-heatmap", "otel"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["summary", "info", "usage"]},
        {"group": "cost-context", "tabs": ["dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "call-tree", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "okf"]}
      ]
    },
    "note": "Rule 2: row = tools, logs, bash, tool-heatmap, otel. Rule 5: transcript is empty (logs, bash promoted, raw-logs hidden) and dropped."
  },
  {
    "id": "LR-07",
    "input": {"lensRow": {"lens": "all", "active": "bash", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"],
      "extra": null,
      "more": []
    },
    "note": "Rule 1: the All tabs lens returns visible unchanged, no extra and no More from the rule (width overflow is the renderer's job)."
  },
  {
    "id": "LR-08",
    "input": {"lensRow": {"lens": "cost", "active": "advisor", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "usage", "call-tree", "context-growth", "dashboard", "otel"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["info"]},
        {"group": "transcript", "tabs": ["logs", "bash"]},
        {"group": "cost-context", "tabs": ["context-usage", "agent-tree", "timeline", "tool-heatmap", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "tools", "okf"]}
      ]
    },
    "note": "The active tab advisor is hidden. Rule 3: it is not in visible, so extra = null; it appears nowhere. Row and More as LR-02."
  },
  {
    "id": "LR-09",
    "input": {"lensRow": {"lens": "cost", "active": "call-tree", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["summary", "usage", "call-tree", "context-growth", "dashboard", "otel"],
      "extra": null,
      "more": [
        {"group": "overview", "tabs": ["info"]},
        {"group": "transcript", "tabs": ["logs", "bash"]},
        {"group": "cost-context", "tabs": ["context-usage", "agent-tree", "timeline", "tool-heatmap", "sysctx", "harness-usage"]},
        {"group": "effects", "tabs": ["change-surface", "tools", "okf"]}
      ]
    },
    "note": "The active chart call-tree is promoted. Rule 3: it is in row, so extra = null and it is not repeated after a divider."
  },
  {
    "id": "LR-10",
    "input": {"lensRow": {"lens": "harness", "active": "timeline", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "context-growth", "context-usage", "agent-tree", "timeline", "tool-heatmap", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {
      "row": ["sysctx", "context-usage", "harness-usage", "okf", "info"],
      "extra": "timeline",
      "more": [
        {"group": "overview", "tabs": ["summary", "usage"]},
        {"group": "transcript", "tabs": ["logs", "bash"]},
        {"group": "cost-context", "tabs": ["dashboard", "context-growth", "agent-tree", "tool-heatmap", "call-tree", "otel"]},
        {"group": "effects", "tabs": ["change-surface", "tools"]}
      ]
    },
    "note": "Rule 3: the chart timeline is visible and not in the Harness row, so extra = timeline. Rule 4: it leaves rest, so cost-context in More keeps the other charts and otel."
  },
  {
    "id": "LD-01",
    "input": {"lensDefaultTab": {"lens": "cost", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {"tab": "usage"},
    "note": "Cost's default is usage; usage is visible."
  },
  {
    "id": "LD-02",
    "input": {"lensDefaultTab": {"lens": "what-happened", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {"tab": "summary"},
    "note": "What happened's default is summary; summary is visible."
  },
  {
    "id": "LD-03",
    "input": {"lensDefaultTab": {"lens": "harness", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {"tab": "sysctx"},
    "note": "Harness's default is sysctx; sysctx is visible."
  },
  {
    "id": "LD-04",
    "input": {"lensDefaultTab": {"lens": "failed-tool", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {"tab": "tools"},
    "note": "Failed tool call's default is tools; tools is visible."
  },
  {
    "id": "LD-05",
    "input": {"lensDefaultTab": {"lens": "all", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard", "call-tree", "sysctx", "harness-usage", "otel", "change-surface", "tools", "okf"]}},
    "expected": {"tab": "summary"},
    "note": "All tabs' default is summary."
  },
  {
    "id": "LD-06",
    "input": {"lensDefaultTab": {"lens": "failed-tool", "visible": ["summary", "info", "usage", "logs", "bash", "dashboard"]}},
    "expected": {"tab": "summary"},
    "note": "Rule 2: Failed tool call's default tools is not in visible, so the result falls back to summary (not the first promoted visible tab logs)."
  }
]
```

## Mutations

- "Row in registry order instead of lens order" -> LR-05 (info would come first), LR-01 (call-tree
  would come after context-growth and dashboard).
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
