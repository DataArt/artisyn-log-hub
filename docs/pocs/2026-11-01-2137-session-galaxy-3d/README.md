# PoC: Session Galaxy — a 3D replay of one Claude Code session

No task folder yet. This PoC follows the competitive study: `docs/competitive-research/README.md`,
`docs/competitive-research/gap-closing-plan.md` (the 3D graph was listed as "reject — novelty") and
`docs/competitive-research/claude-hindsight.md` (3D execution graph built on `react-force-graph-3d`). The
2D reference for the layout idea is Agent Flow (agents as nodes with cost, tool calls around them, a live timeline).

## Question

Can real Log Hub data (one root session, its workflow runs, sub-agents and tool calls) produce a 3D,
animated view striking enough for marketing material (site, deck, a short video), and does it still say
something about *why* a session cost what it did?

## What it shows

- **Root session** — a golden wireframe icosahedron with its own cost.
- **Workflow runs** — violet rotating rings ("Implement plan #1 · 7 agents", "Health checks #2 · 13 agents").
- **Agents** — spheres whose size and colour (blue → orange → red) follow the agent's stored cost, labelled
  with the chunk / check name and cost.
- **Tool calls** — small dots around their agent, coloured by tool family; failed calls are red and larger.
- **Replay** — events in chronological order with idle gaps capped at 45 s, so a 5-hour session plays in
  30 s / 60 s / 2 min. Each call pulses its agent and fires a particle along the links; the cost counter
  accrues the stored session costs, spread over each agent's calls by token weight.
- **HUD** — running cost, agent / call / error counters, a ticker of the latest calls, an activity
  sparkline timeline with error marks (click to seek), Orbit camera, click a node to fly to it and see
  its card. At the end: a card with the total and the top cost centres.

## How to run

From this folder:

```sh
# 1. (optional) re-extract another session from the local dev DB (Docker container log-hub-postgres)
node extract.js --session <root session uuid>
# 2. open the page — works straight from disk, no server needed
start index.html            # Windows; or open index.html in any browser
```

URL options: `index.html?d=30` (replay length in seconds), `index.html?at=0.7` (start at 70 % of the session),
`index.html?at=1` (everything shown, end card).

Needs internet for the three.js / 3d-force-graph modules (`esm.sh`, pinned `three@0.186.0`,
`3d-force-graph@1.80.1`, `three-spritetext@1.10.0`). A product version must vendor them (offline-first).

## Data

`data.js` holds session `a3e94d1d…` (`/adlc-lh:implement-deep 2026-10-21-workflow-session-readability`, a
real session of this repository): 41 agents in 3 workflow runs plus 5 review agents, 517 tool calls,
10 failed calls, $26.34, 5 hours. `extract.js` keeps only tool names, a short target (file base name, first
line of a shell command, grep pattern, skill name) and costs. Absolute paths are cut to the repo-relative
part or to `<abs>/<basename>`; e-mail addresses become `<email>`. No prompts except the root slash command.

## Result

**Yes — it works on real data and looks like an ad.** See `screenshot-replay.png` (70 % into the replay)
and `screenshot-end-card.png` (the end card).

- The structure reads at a glance: three workflow "galaxies" around the main session, the 6-chunk
  implementation run with one hot agent (Chunk 6/6: Tests, $2.98), the two health-check fans, the five
  review agents near the root.
- The *why* is still there: size and heat show where money went, red dots show failures, the end card
  ranks the cost centres (main session 48 %, Chunk 6/6 11 %, …).
- Performance: 560 nodes, bloom post-processing, 60 fps in Chromium (measured with Playwright).
- Caveats: labels of small agents are only readable after a click / zoom; the main-session cluster (300+
  calls) becomes one bright blob; three.js prints "Multiple instances of Three.js being imported"
  (`esm.sh` builds `three` and `three/webgpu` separately — harmless here, would go away with a bundled build).

**Recommendation:** use it as a marketing / demo asset (record a 30–60 s screen capture of the replay).
As a product feature it is a "Galaxy" tab for one session at most; the analytical answers stay in the 2D
views (cost tables by prompt / agent, swimlanes — P4 and P6 of the gap-closing plan).
