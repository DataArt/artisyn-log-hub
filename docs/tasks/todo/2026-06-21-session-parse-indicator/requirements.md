# T-35: Session Log Parsing Indicator

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-06-21

## Description

once session logs are loaded from server in client and parsing starts show parsing indicator

## Functional Requirements

- When the client receives session log data from the server and begins parsing, display a visual parsing indicator to the user.
- The indicator should appear immediately after the data fetch completes and disappear once parsing is finished.
- The parsing indicator must be distinct from the initial loading/fetching indicator (which covers the network request phase).
- The indicator should not block interaction with other parts of the UI.

## Acceptance Criteria

- [ ] A parsing indicator (e.g., spinner, progress bar, or status text such as "Parsing…") is visible while log data is being processed client-side.
- [ ] The indicator appears only after the server response arrives (not during the fetch itself).
- [ ] The indicator disappears automatically when parsing completes.
- [ ] No console errors are introduced.

## Open Questions

- What visual style for the indicator — inline spinner inside the session viewer, a status bar message, or a skeleton overlay?
- Should the indicator show progress (e.g., "Parsing 1200 lines…") or just a generic busy state?

## Notes

<!-- Append timestamped notes here as work progresses -->
