# T-120 — Notes

## 2026-08-28 — Origin and revision history

Raw idea as originally reported by the owner:

> in http://localhost:5173/#/teams/<team-id>/repos/<repo-id>?session=<session-id>&tab=change-surface
> is scattered BUT it has 3 files touched in doc and in client — this is very focused
> revise rule — criteria should take into account number of top folders touched, total files
> changed, and reasonable treshold

Revision trail of `requirements.md` (all on 2026-08-28):

- Owner answered all of the original open questions in `open-questions.md`; the answers were
  integrated into the requirements: the "≤ threshold files → focused" rule (FR-3), the softened
  stance on preserving T-117's leniency framing (FR-5), AC-1 retargeted from "non-scattered" to
  the explicit "focused" band, and AC-4 added for the flipped 2-file / 2-module pinned case.
- Scope extension by the owner: the small-change threshold stopped being a hardcoded constant and
  became a per-repository setting ("Merge surface threshold", measured in changed files),
  configurable separately for a private repo and for a team, with the default raised from the
  hardcoded 5 to 10. This added FR-6…FR-13 and AC-5…AC-10.
- Consequence of that extension: the earlier `impl-plan.md` (a 3-chunk, server-constant-only change
  with no config, API or UI work) went stale and must be re-planned before implementation. This is
  still open and is tracked as a one-line pointer in the requirements' Notes section.
