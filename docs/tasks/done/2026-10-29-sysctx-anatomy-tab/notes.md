# Notes — System Context Anatomy tab

## 2026-10-29

- Owner answers: a byte-based token estimate is enough (only the total is exact); the tab is
  placed as the **rightmost** tab of the session view; git status **is** included in `snapshotId`
  (a status change resends the snapshot).
- PoC [`docs/pocs/2026-10-29-1504-sysctx-anatomy/`](../../../pocs/2026-10-29-1504-sysctx-anatomy/README.md):
  the transcript already carries the startup context as typed attachments (`prompt_snapshot`,
  `skill_listing`, `instructions`, `deferred_tools_delta`, `mcp_instructions_delta`,
  `agent_listing_delta`, `session_context`), so every section except tool JSON schemas is measured
  exactly per item; tool schemas (~69 % on the sample session) remain the Unallocated partition.
  File origin, size and git status come from disk (hook side).
