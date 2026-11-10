# 2026-11-10: Team Analytics and Reports Tabs

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** client, server
**Owner:** denis.tsyplakov
**Created:** 2026-11-10
**Tracker:** GH-119 https://github.com/DataArt/artisyn-log-hub/issues/119

## Description

Follow-up to 2026-11-05-budgets-threshold-alerts.

Team analytics and reports: the team page (`TeamDetailPage.tsx`, today only Members / Repositories /
Invitations / OTEL tabs) gets its own Analytics and Reports tabs that aggregate over all the team's
linked repositories (acknowledged members visible under the team access mode), including the Budget
burn view and Budget report for team budgets from 2026-11-05-budgets-threshold-alerts (which ships
them repository-only).

## Functional Requirements

- FR-1 The team page gets an "Analytics" tab with the repository Analytics views, computed over all
  the team's linked repositories.
- FR-2 The team page gets a "Reports" tab with the repository report catalog, computed over all the
  team's linked repositories, with on-page preview and PDF download.
- FR-3 Team-scope data counts only sessions of acknowledged members visible under the team's access
  mode, the same population as the team budget spend in 2026-11-05-budgets-threshold-alerts.
- FR-4 The Analytics tab includes the Budget burn view and the Reports tab includes the Budget report,
  both for the team's budgets.
- FR-5 The tabs are visible under the existing team-wide access rule.

## Acceptance Criteria

- [ ] FR-1 A team's Analytics tab shows each view with totals equal to the sum over its linked
  repositories for the same filters.
- [ ] FR-2 A team report previews and downloads as a PDF, with the team named in its header.
- [ ] FR-3 Sessions of non-acknowledged members, or members hidden by the access mode, are not counted.
- [ ] FR-4 The team Budget burn view and Budget report show the same spend as the team Spend tab.
- [ ] FR-5 A user without team-wide access does not see the tabs and gets an access denial from their
  endpoints (API contract row).

## Notes

<!-- Append timestamped notes here as work progresses -->
