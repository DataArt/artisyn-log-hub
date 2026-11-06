# PoC: Session Map — a practical 2D map of one session's agents

No task folder yet. Follow-up of `../2026-11-01-2137-session-galaxy-3d/` (the 3D galaxy turned out to be a
marketing asset, too bright and not usable for analysis) and of `docs/product-kb/competitive-research/gap-closing-plan.md`
(P4 swimlanes / running markers, P6 by-agent tables). The layout idea comes from Agent Flow (agents as
cards with cost and context, tool calls attached, a timeline); the styling follows `ui-principles.md`.

## Question

Can one screen show a whole multi-agent session (root, workflow runs, every sub-agent) so that a user
answers *where the money and time went, what failed and what each agent did* without opening 41 logs?

## What it shows

- **Header:** cost so far / total, agents started, tool calls, failed calls, wall time at the playhead.
- **Main session card:** own cost vs whole-tree cost and own share, tool-family mix bar, top tools,
  peak context against the model's window.
- **One column per workflow run** (plus "Agents spawned by the main session"): group card with cost,
  agent count, calls, duration, failures and tool mix; under it the agents as compact cards.
- **Agent card:** name (chunk / check / Agent description), failures badge, cost with share of the tree
  and a zone-coloured bar relative to the most expensive agent (green / blue / orange + legend, as in
  `ui-principles.md`), the part already spent at the playhead, tool-family mix, calls and top tools,
  peak context bar (fixed blue — a bounded ratio) and duration.
- **States from the timeline:** not started yet (faded, dashed), running (blue "running" tag), done.
- **Highlight:** agents with failed calls / top 5 by cost; **order:** start time or cost.
- **Side panel (click a card):** cost, model, calls, failures, peak context, active window, cost per call,
  filter chips by tool family / failed, and the full call log (time, tool, target, ✗). Clicking a call
  moves the timeline to it.
- **Timeline:** stacked calls per time bin by tool family, failures as red marks on top, the cumulative
  cost line, half-hour ticks; drag to scrub, play at 60× / 300× / 1200×.

## How to run

Open `index.html` in a browser (works from disk, no server, no internet — plain HTML/JS, no libraries).
It reads `../2026-11-01-2137-session-galaxy-3d/data.js`; regenerate it for another session with
`node ../2026-11-01-2137-session-galaxy-3d/extract.js --session <root session uuid>`.

URL options: `?at=0.55` (playhead at 55 % of the session), `&select=1` (open the most expensive agent).

## Result

**Yes — it is usable, and it answers questions the galaxy could not.** Screenshots: `screenshot-map.png`
(55 % into the session, most expensive agent open), `screenshot-early-errors.png` (12 %, highlight "with
failed calls", agents not started yet faded).

What the real session (41 agents, 517 calls, $26.34) shows at a glance:

- The main session is 48 % of the cost; its peak context reached 338k of 1M.
- The implementation run (7 agents, $6.21) holds the cost; "Chunk 6/6: Tests" alone is $2.98 (11 %) with
  82 calls and 2 failures; the 29 health-check agents are cheap ($0.14–0.43 each) but there are two
  full rounds of them.
- The timeline shows the idle stretch 17:00–17:30 and that most cost accrued before 18:00, with a long
  cheap tail (reviews, checks).

Data reuse: everything comes from the same `data.js` as the galaxy (tool name, short target, timestamps,
stored costs, peak context); no extra queries are needed, so a product version can be built from the
session-tree data the Session view already loads.

Limits: one column per workflow run gets long for 16+ agents (needs collapsing or a compact mode);
StructuredOutput calls of workflow agents count as "other"; per-call cost is the stored agent cost spread
by token weight, not a per-call price.

**Recommendation:** worth a task — a "Map" tab in the session view (P4/P6 of the gap-closing plan), built
in `client/` with the existing session-tree data; the 3D galaxy stays a marketing asset.
