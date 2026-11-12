# Verifier flows — what the failed run shows (2026-11-12)

Source: run `log_hub_big_test-20261112-090440/_report/` (S2, S5, S8 `verdict.json`, S5 page snapshots).

- **S8 `denied`.** The verifier found the `Write` call in the turn's Files section under "Code"
  without expanding anything: `⊘ denied.txt` marker + `tool-status-badge` reading `⚠ requested`, no
  `title`. So the file row is visible by default; one click on it opens `ToolCallDetailModal`
  (Radix `Dialog` → `role="dialog"`, no own test id) around `ToolCallView`, whose
  `tool-status-badge` carries `⊘ rejected` with `title="rejected by the user"`.
  Flow: navigate → snapshot → click row → evaluate/snapshot inside the dialog = 4 calls with no
  slack; the budget goes 4 → 5.
- **S8 `bash`.** The verifier saw `✓ ok` on `node --version` and `✗ error` on `process.exit(3)` —
  the product is right, only the prompt's "no badge" rule was wrong. Flow (navigate, 2 clicks,
  snapshot) fits the existing budget of 5; S1's asserted total (40) stays.
- **S5 `systemContext`.** The Logs turn showed a `§ Rules cli-flags · ~92 tok` chip, so the session
  did load the path-scoped rule — it is expected on the Anatomy tab in the loaded or the on-demand
  group. The Logs tab shows a "Startup context … View anatomy" line linking to the Anatomy tab.
- **S2 `systemContext`.** Same: only `startup-context-line` on Logs; the panel is gone.
- **Anatomy flow** (navigate `&tab=sysctx` → snapshot → click Skills row → optional "Show all" →
  click Instruction files row → evaluate rows) needs up to 6 calls plus one retry; the budget goes
  7 → 8. S2/S5/S8 totals are not asserted in `scripts/__tests__/big-prod-e2e-test.test.js`.
- **Partition kinds**: `data-kind` values `skills` and `instruction-file`
  (`sysctx-anatomy-constants.ts:16-17`, labels "Skills" / "Instruction files").
- Could not re-check the Anatomy rows themselves: the run's stand is disposable and gone; the
  re-run in the acceptance criteria is the check.
