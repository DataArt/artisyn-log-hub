# T-91: Header View Mode Switch

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-08-11

## Description

Add a view mode switch in the header with three modes: "Simple Dev", "Full Dev", and "Manager".
The current (only) view today is effectively "Full Dev". The selected view mode should affect what
is shown in the session list area and the session details area. For this task, only "Full Dev"
needs a real, working behavior (the current behavior); "Simple Dev" and "Manager" modes are
placeholders (TBD) — the switch should exist and be selectable, but their filtered/reduced content
is out of scope for now.

## Functional Requirements

- Add a view-mode switch control to the header with three options: Simple Dev, Full Dev, Manager.
- Default the selected mode to "Full Dev", matching current behavior.
- Wire the selected mode into the session list area and session details area so they can branch
  behavior per mode.
- "Full Dev" mode preserves the current, unmodified behavior of the session list and session
  details areas.
- "Simple Dev" and "Manager" modes are placeholders only (TBD) for this task — no specific
  content/behavior changes are required for them yet.

## Acceptance Criteria

- [ ] Header shows a switch/control with three selectable options: Simple Dev, Full Dev, Manager.
- [ ] On initial load, "Full Dev" is selected and the app behaves exactly as it does today.
- [ ] Switching to "Simple Dev" or "Manager" changes the active mode state (visibly reflected in
      the header control) without requiring the list/details areas to already implement distinct
      content for those modes.
- [ ] Session list area and session details area both receive/consume the current view mode
      (e.g. via shared state/context), so future work can branch on it without re-plumbing.

## Common sense considerations

- Switch control: reuse the existing `ui/toggle-group.tsx` `ToggleGroup` component, the idiomatic
  3-way control already used for `SessionExportSection`, `AnalyticsControls`, and
  `ExportScopePicker`; place it in `MainNav.tsx` alongside the other header controls.
- The new mode type/state must not be named `ViewMode` — `SessionListPanel.tsx` already exports a
  `ViewMode` type (`'branch' | 'date' | 'user' | 'plain'`) for list grouping, an unrelated concept.
  Use a distinct name (e.g. `AppMode`/`HeaderMode`) to avoid collision.
- No context currently spans the header and the repository list/details (`MainNav`/`AppShell` sit
  above the router; list/details live under `RepositoryView` and are wired via `useRepositoryViewState`
  URL params, not context). A new context must be introduced and provided high enough (e.g. in
  `AppShell.tsx`) to reach both `MainNav` and the repository subtree (`SessionListPanel`,
  `SessionDetailPane`).

## Open Questions

- Should the selected view mode persist across reloads (e.g. localStorage) or reset to "Full Dev"
  each session?
- Should "Simple Dev" and "Manager" modes show any placeholder indicator (e.g. a "Coming soon"
  badge) in the list/details areas, or remain visually identical to "Full Dev" until implemented?

## Notes

<!-- Append timestamped notes here as work progresses -->
