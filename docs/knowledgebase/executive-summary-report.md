---
type: "Reference"
title: "Executive Summary Report"
description: "The leadership-facing Executive Summary report on the repository Reports tab: parameters, sections (KPIs, trends, model mix, top sessions, per-engineer breakdown), the single cost rollup every aggregate reads, the excluded-session and limitations disclosures, and the PDF export with its CSP 'wasm-unsafe-eval' requirement."
tags:
  - reports
  - client
  - server
  - cost
timestamp: "2026-10-14T00:00:00+04:00"
---

# Executive Summary Report

The Executive Summary is the first report in the repository **Reports** tab (category "Summary" in
`client/src/viewer/pages/repository/reports/report-catalog.ts`). The Reports tab shows a report
tree, a parameter strip and an on-page preview of the selected report, which can be downloaded as a
PDF. The Executive Summary is the report meant for leadership.

| Piece | File |
|---|---|
| Endpoint | `GET /api/v1/repositories/:repoId/reports/executive-summary` in `server/src/logs/reports/reports.controller.ts` |
| Aggregation | `server/src/logs/reports/executive-summary.service.ts` (`ExecutiveSummaryReport`) |
| Page | `client/src/viewer/pages/repository/reports/executive-summary/ExecutiveSummaryReport.tsx` |
| PDF | `client/src/viewer/pages/repository/reports/executive-summary/pdf/ExecutiveSummaryPdfDocument.tsx` |
| PDF download hook | `client/src/viewer/pages/repository/reports/downloadReportPdf.ts` (`useReportPdfDownload`) |

## Purpose and parameters

- `startDate` and `endDate` are **required** ISO 8601 dates; a missing or invalid one is a `400`.
- `users` and `branches` are optional comma-separated filters.
- `attr` filters by session attribute (see
  [turn-end-cost-advisor.md](turn-end-cost-advisor.md) § "Attributes as a chart dimension"). The
  report has no group-by.
- `teamId` scopes the report to a team view. Repository access and the team's access mode are
  checked like every other report (see
  [authorization-and-authentificaiton.md](authorization-and-authentificaiton.md)).

## Sections

| Section | Content |
|---|---|
| KPI tiles (`KpiTiles.tsx`) | Total cost, sessions, active users, team size (team view only), avg cost per session, lines changed, avg cost per line, avg lines per hour, avg session length. Each headline tile shows a delta against the previous period. Advisor spend and attribute-extraction spend are separate tiles, never merged into total cost. |
| Usage and cost trends (`UsageTrendChart.tsx`, `CostTrendChart.tsx`) | Weekly buckets: ISO weeks, with partial edge weeks shortened to the range and labelled by their start date. |
| Avg cost per session (`AvgCostPerSessionChart.tsx`) | The weekly average cost per session. |
| Model mix (`ModelMixChart.tsx`) | Session count, share, cost and cost share per model. A root session's whole rolled-up cost, sub-agents included, is attributed to its own first-observed model. |
| Top 5 sessions by cost | Date, engineer, branch, duration, cost, model and tokens — no prompt text. A row whose model has no pricing shows a no-pricing badge (`costUnavailableReason: 'unknown-model'`). |
| Per-engineer breakdown (`EngineerBreakdownTable.tsx`) | Per user: sessions, share, total cost, avg cost per session, avg session length, cost per line, lines per hour, sub-agents per session. |
| Data source and limitations (`ExecutiveSummaryLimitations.tsx`) | See below. |

## Cost rollup and limitations

**One cost value per root session.** The service first selects the eligible sessions with their own
cost, then computes per root the sub-agent cost and count over the session tree
(`descendantSessionsCte`, see [session-metrics-scope.md](session-metrics-scope.md)). Each row's
`total_cost` is then rewritten **once** as own cost + descendant cost — or the session's OTEL cost
when that covers the whole tree (`resolveSessionTotalCost`, see
[llm-call-math.md](llm-call-math.md)). Every aggregate — headline, weekly buckets, model mix, top
sessions, engineer totals — reads this one value, so engineer and weekly totals add up to the
headline. Lines changed are tree-scoped the same way.

**Previous period.** The comparison window is the immediately preceding window of equal length,
`[startDate − length, startDate − 1ms]`. It carries total cost, sessions, active users and avg cost
per session, and is `null` when that window has no sessions.

**Excluded sessions.** A session whose own model has no `model_pricing` row contributes no own cost.
The report counts such sessions (`excludedSessionCount`) and lists their models (`excludedModels`)
instead of silently under-reporting.

**Data Source & Limitations** is a fixed closing block, mirrored in the PDF
(`ExecutiveSummaryLimitationsPdf.tsx`). It states that figures come from uploaded Claude Code
telemetry rather than billing APIs, that the scope is a single repository, that offline or
never-uploaded sessions are missing, and how cost is calculated. It adds a notice when sessions
were excluded for missing pricing.

## PDF export

"Download as PDF" builds the document in the browser with `@react-pdf/renderer`
(`pdf(doc).toBlob()`) and downloads it as `executive-summary_<start>_<end>.pdf`. A rendering failure
is caught and shown as a download error instead of failing silently.

`@react-pdf/renderer` instantiates WebAssembly, so the Content Security Policy in
`server/src/common/security-headers.ts` must keep `'wasm-unsafe-eval'` in `script-src`. Without it
PDF generation fails in the browser. `'unsafe-eval'` is not used because it would allow JavaScript
`eval` as well, which `'wasm-unsafe-eval'` does not.
