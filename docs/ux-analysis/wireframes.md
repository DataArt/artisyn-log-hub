# Wireframes: the whole picture

How waves 1 and 2 look together. ASCII sketches, not pixel layouts; names and figures are examples.

## W1. Session pane — lens + grouped tab bar + Summary hub (wave 1: ideas 1–4)

```
┌─ Log Hub ───────────────────────────────────────────────── [🔍 Jump to…  Ctrl+K]  ? 🔔 dt@… ─┐
│ ┌ Nav ──────────┐ ┌ Sessions ─────────┐ ┌ Session 3f2a… · main · dt@dataart.com · 2h 14m ───┐ │
│ │ Teams         │ │ [Search sessions] │ │ Lens: (What happened)  Cost  Harness  Failed tool  All │
│ │  ▸ Platform   │ │ ▾ main            │ │ ─────────────────────────────────────────────────── │
│ │ My Repos      │ │  ● 3f2a  $4.10    │ │ OVERVIEW        │ TRANSCRIPT       │ EFFECTS    More ▾│
│ │  ▸ log-hub    │ │  ○ 91bc  $0.80    │ │ [Summary] Info  │ Logs  Bash·34    │ Change surface   │
│ │ API Keys      │ │ ▾ feature/x       │ │                 │                  │                  │
│ │ Installed     │ │  ○ 77de  $2.35    │ │ ┌ Executive band ────────────────────────────────┐   │
│ │   Hooks  ⚠1   │ │                   │ │ │ $4.10 │ 2h14m │ 61 turns │ 92% cache │ 3 issues │   │
│ │ Admin         │ │                   │ │ └────────────────────────────────────────────────┘   │
│ │               │ │                   │ │ Where to look next                                   │
│ │               │ │                   │ │ ┌──────────────┐┌──────────────┐┌──────────────┐     │
│ │               │ │                   │ │ │ Bash         ││ Tools/MCP    ││ Startup ctx  │     │
│ │               │ │                   │ │ │ 34 calls     ││ 3 failed  ⚠  ││ 18.2k tokens │     │
│ │               │ │                   │ │ │ 2 errors     ││ of 112       ││ CLAUDE.md 4k │     │
│ │               │ │                   │ │ │ Open →       ││ Open →       ││ Open →       │     │
│ │               │ │                   │ │ └──────────────┘└──────────────┘└──────────────┘     │
│ │               │ │                   │ │ ┌──────────────┐┌──────────────┐┌ ─ ─ ─ ─ ─ ─ ─┐     │
│ │               │ │                   │ │ │ Changes      ││ Advisor      ││ OKF          │     │
│ │               │ │                   │ │ │ 14 files     ││ 2 hints      │  no reads       (dimmed)
│ │               │ │                   │ │ │ Open →       ││ Open →       ││              │     │
│ │               │ │                   │ │ └──────────────┘└──────────────┘└ ─ ─ ─ ─ ─ ─ ─┘     │
│ │               │ │                   │ │ Explore: [Debug a tool call] [Why this cost]          │
│ │               │ │                   │ │          [Harness & context] [Code changes]           │
│ └───────────────┘ └───────────────────┘ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The **lens** decides which groups and tabs are shown first; "What happened" here.
- The tab bar shows **groups** (Overview / Transcript / Effects); groups and tabs not in the lens go to
  **More ▾**. Counts and health dots ("Bash·34") come from data already loaded.
- **Summary** is the hub: one card per tab with one figure and "Open →"; empty tabs are dimmed.

## W2. "More ▾" opened — nothing is gone

```
                                        │ Logs  Bash·34    │ Change surface   │ More ▾ │
                                        └──────────────────────────────────┬──────────┘
                                          ┌ More ────────────────────────────┐
                                          │ COST & CONTEXT                   │
                                          │   Statistics                     │
                                          │   Charts                         │
                                          │   System context anatomy         │
                                          │   Harness usage                  │
                                          │   OTEL                           │
                                          │ EFFECTS                          │
                                          │   Tools/MCP          3 failed ⚠  │
                                          │   OKF                (empty)     │
                                          │ TRANSCRIPT                       │
                                          │   Raw Logs                       │
                                          │ ──────────────────────────────── │
                                          │ Show all tabs (lens: All)        │
                                          └──────────────────────────────────┘
```

Opening a tab from "More" keeps the lens; `tab=` in the URL always wins over the lens.

## W3. Same session, lens "Cost"

```
│ Lens:  What happened  (Cost)  Harness  Failed tool  All                                 │
│ ─────────────────────────────────────────────────────────────────────────────────────── │
│ OVERVIEW                    │ COST & CONTEXT                                   │ More ▾ │
│ Summary  [Statistics]  Advisor·2 │ Charts  System context anatomy  OTEL                  │
│                                                                                         │
│ ┌ Statistics ───────────────────────────────────────────────────────────────────────┐  │
│ │ Tokens by model · cache read ratio · cost by turn …  (existing panel, unchanged)   │  │
│ └────────────────────────────────────────────────────────────────────────────────────┘  │
```

Same panels as today, different order and default tab.

## W4. Command palette (wave 2: idea 5)

```
            ┌───────────────────────────────────────────────────────────────┐
            │ 🔍 cost                                                        │
            ├───────────────────────────────────────────────────────────────┤
            │ SESSION TABS (current session 3f2a…)                           │
            │  ▸ Statistics            tokens, cache, cost by turn           │
            │    Charts › Call tree    cost per call                         │
            │    OTEL                  hidden-call cost                      │
            │ REPOSITORY (log-hub)                                           │
            │    Reports › Cost by User                                      │
            │    Reports › Cost by Branch                                    │
            │    Analytics › Cost                                            │
            │ HELP                                                           │
            │    How cost is calculated                                      │
            ├───────────────────────────────────────────────────────────────┤
            │ ↑↓ move · Enter open · Esc close                               │
            └───────────────────────────────────────────────────────────────┘
```

Entries come from the tab registry (label + description + synonyms), the left-nav data and
`user-docs/nav.json`.

## W5. Home page (wave 2: idea 6)

```
┌ Nav ──────────┐ ┌ Home ──────────────────────────────────────────────────────────────────────┐
│ Teams         │ │ What do you want to find?                                                  │
│ My Repos      │ │ ┌────────────────────┐┌────────────────────┐┌────────────────────┐         │
│ API Keys      │ │ │ Why was a session  ││ Which tools fail   ││ Is my hook         │         │
│ Installed     │ │ │ expensive?         ││ most?              ││ healthy?           │         │
│   Hooks  ⚠1   │ │ │ → lens Cost        ││ → Tools/MCP        ││ → Hook state       │         │
│ Admin         │ │ └────────────────────┘└────────────────────┘└────────────────────┘         │
│               │ │ ┌────────────────────┐┌────────────────────┐                               │
│               │ │ │ What does Claude   ││ Is my CLAUDE.md    │                               │
│               │ │ │ load at startup?   ││ being used?        │                               │
│               │ │ │ → lens Harness     ││ → OKF / Harness    │                               │
│               │ │ └────────────────────┘└────────────────────┘                               │
│               │ │                                                                            │
│               │ │ ┌ Needs attention ──────────────┐ ┌ This week ───────────────────────┐     │
│               │ │ │ ⚠ hook on dt-laptop: 2 errors │ │ log-hub        $38.20  ▁▃▅▂▇     │     │
│               │ │ │ ● 3f2a: 3 failed tool calls   │ │ platform-api   $12.05  ▂▂▃▁▂     │     │
│               │ │ │ ● 2 sessions with advisor tips│ │ team Platform  $50.25            │     │
│               │ │ └───────────────────────────────┘ └──────────────────────────────────┘     │
│               │ │ ┌ Recent ───────────────────────┐ ┌ Pinned ──────────────────────────┐     │
│               │ │ │ 3f2a · log-hub · Summary      │ │ ★ log-hub › Reports › Executive  │     │
│               │ │ │ 91bc · log-hub · Logs         │ │ ★ Analytics › Cost by user 30d   │     │
│               │ │ └───────────────────────────────┘ └──────────────────────────────────┘     │
└───────────────┘ └────────────────────────────────────────────────────────────────────────────┘
```

Every card is a deep link into an existing view, with the matching lens and filters preset.

## W6. Second tier on the same screen (for reference)

```
│ OVERVIEW            │ TRANSCRIPT      │ …                      Breadcrumb:
│ Summary ⓘ  Info ⓘ   │ Logs ⓘ  Bash ⓘ  │                        Team Platform › log-hub › 3f2a › Transcript › Logs
     └ ⓘ hover: "Answers: what happened turn by turn. Learn more →"  (opens offline help article)

Repository header:  log-hub   [Sessions] [Analytics] [Reports] [Tools/MCP] [OKF] [OTEL]   ⚙ ▾
                                                                      ⚙ ▾ → Settings · Hook health ● · Import/export
```
