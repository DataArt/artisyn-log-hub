# Notes — 2026-11-11 Session Network Tab

## 2026-11-11

**Original raw idea (user, translated):** is there a good way to see where Claude went on the network
and what it searched for — especially when the network access was a Bash command or a whole script?
Capture network activity: searches, `curl` and other commands for Windows and Linux, `ssh`; ideally
also Node.js and Python scripts. Build data collection plus a nice session tab showing where the
agent went, what kind of access it was, how much traffic and how long it took. As an alternative
view — a HAR-like call diagram as in Chrome DevTools. The first draft had two views (topology and
timeline) and a "network" preset in Monitored Tools; Node tap loaded via `NODE_OPTIONS=--require`.
These were superseded by FR-3 (always-captured standard set), FR-4 (`--import data:` loader) and
FR-6 (three views).

**Python resolved:** Python is banned only for utility code; Python shipped as part of the product
(the hook's Python tap) is allowed — exception added to `CLAUDE.md` → Tooling.

**User direction for the review:** (1) network data is collected ALWAYS (taps on by default, see
FR-9); (2) captured text can be huge — capture only bounded excerpts, never kill the DB (FR-11);
(3) build a PoC to validate the risky parts (taps, classifier, volume); (4) wireframes must be
high-quality and easy to understand — table, topology and waterfall views.
