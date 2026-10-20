# T-4: Top Used Analytics Table

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-06-14

## Description

Add a new "Top Used" view to the repository analytics page that shows ranked tables
of the most-used file categories, MCP servers, and vision sessions for the selected
time range and filters. Unlike the existing chart views this is always a table — no
vertical/horizontal layout distinction. Each row includes a 200 px micro bar chart
(hourly granularity) on the right showing when that item was used across the time window.

## Functional Requirements

- Add `'top-used'` to `AnalyticsState['view']` union type in `RepositoryAnalytics.tsx`.
- Add "Top Used" entry to `VIEW_OPTIONS` with label and description.
- Hide the vertical/horizontal layout toggle when view is `'top-used'` (the view is always a table).
- Render a new `TopUsedTable` component when `currentView === 'top-used'`; ignore `layout` state.
- **Top N selector** — pill button group [10 | 20 | 50 | 100], default 10, shown above the table sections.
  Controls the maximum rows shown per section.
- **Three collapsible sections** (chevron header, expanded by default):
  1. **File Categories** — aggregated from `TimelineSession.fileStatsByCategory`.
     Columns: `#`, Category name (monospace), Files count, Size (bytes → KB/MB), Timeline chart.
     Sorted by total file count descending.
  2. **MCP Servers** — aggregated from `TimelineSession.mcpCallsByServer`.
     Columns: `#`, Server name (monospace), Calls, Timeline chart.
     Sorted by total call count descending.
  3. **Vision** — sessions where `imageCount > 0`, sorted by `imageCount` descending.
     Columns: `#`, Session (first 45 chars of `firstPrompt`, fallback to `sessionId` prefix), Images, Size, Timeline chart.
- **Micro bar chart** (right column, 200 px wide, row height ~22 px):
  - Hourly buckets from `startDate` to `endDate` (same granularity as the main charts).
  - Each session is assigned to the bucket of its `startTime`.
  - Bar height proportional to the bucket's value vs the section-row maximum.
  - Rendered as inline SVG; baseline rule at the bottom of the SVG.
  - Empty sections (all zero) show a faint baseline only.
- No new API endpoint needed — derive all data from the existing `timelineQuery.data`
  (`TimelineSession[]` returned by `GET /api/v1/repositories/:repoId/analytics/timeline`).
- Show "No data in selected range" when all three sections are empty.

## Non-Functional Requirements

- `TopUsedTable` must be a standalone file `analytics/TopUsedTable.tsx`; add entry to `client-component-map.md`.
- All computation inside a single `useMemo` keyed on `[sessions, startDate, endDate]`.
- `SectionHeader` and `MicroBarChart` are module-level sub-components (not nested inside the main export).
- Table rows use `hover:bg-muted/30` and `border-b border-border/40` styling consistent with the app's table patterns.
- Use `cn()` from `@/lib/cn` for conditional class names.
- No D3 dependency for the micro chart — pure SVG with arithmetic layout.

## Acceptance Criteria

- [ ] "Top Used" appears in the analytics view dropdown alongside the existing views.
- [ ] Selecting "Top Used" hides the layout toggle (vertical/horizontal).
- [ ] All three sections render and collapse/expand independently.
- [ ] Top N selector changes the visible row count in every section.
- [ ] Micro bar charts show hourly activity with bars only in hours that have sessions.
- [ ] File Categories section ranks by total file count and shows size in human-readable units.
- [ ] MCP Servers section ranks by total call count; hidden if no MCP data exists.
- [ ] Vision section ranks by image count; hidden if no sessions have vision data.
- [ ] Switching back to another view restores the layout toggle.
- [ ] `bun run build` — zero errors; `bun run lint` — zero warnings.
- [ ] `npx vitest run` — all existing tests still pass (no new tests required for this view).
- [ ] No browser console errors when the view is active.

## Open Questions

- Should the Vision section show a per-session row (current plan) or an aggregate single row?
  Currently planned as per-session ranked by `imageCount`.
- Should clicking a Vision row navigate to that session's log view? (Nice-to-have.)
