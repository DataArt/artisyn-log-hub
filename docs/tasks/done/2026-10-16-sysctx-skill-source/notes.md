# Notes — 2026-10-16-sysctx-skill-source

## 2026-10-16 — requirements.md revision history (moved here during distillation)

- The first version of the requirements (no hook change, with a fallback to `skill_listing`) was
  replaced after the owner's decision: a catalog snapshot, no backward compatibility, no fallback.
  The lightweight impl-plan for the first version was deleted as obsolete.
- Following the owner's answers to the Open Questions, the snapshot was extended to the whole
  harness context (`agent-definitions`, `mcp-config`, `system-context` — one mechanism, one row in
  one table; FR-4, FR-6, FR-8, FR-9, FR-18), and cleanup of unused snapshots was added (FR-9a).
  CLAUDE.md files were moved out to `2026-10-16-sysctx-instruction-files`.
