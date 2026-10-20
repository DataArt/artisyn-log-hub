---
type: "Design Principles"
title: "UI Principles"
description: "Access control messaging, error handling, color scheme (light-only), and chart/visualization patterns."
tags:
  - client
  - ui
timestamp: "2026-07-20T22:24:25+04:00"
---

if user tryies to access to something that he does not have acceess to - show "No access"
if some error happens, show "Error"

all english only

## Color scheme

Always use the **light** color scheme. All UI components, modals, panels, and wireframes must use a light background palette. Do not implement or reference dark-mode variants unless explicitly requested.

**Exception — hook log tail (dark surface):** `HookStatePage`'s "Hook log" card (`client/src/viewer/pages/hook-state/HookStatePage.tsx`) renders the raw `hook.log` tail in a fixed dark `<pre>` block (`bg-slate-900`/`#0f172a`, monospace, light text) regardless of the app's light-only color scheme. This matches the existing pattern of rendering raw/terminal-style content and is an intentional, deliberate exception — not a general invitation to add dark-mode variants elsewhere.

if API call fails due to access error - got to login page

---

## Context badge — personal route

When a page is scoped to the current user's personal data (no team context), render an orange `<Badge className="bg-orange-500 text-white">` in the page header to signal the restricted scope. Example: "Private repo view" badge in `RepositoryView.tsx` when `teamId === undefined`.

---

## Zone-color pattern (bar charts)

When a bar chart ranks items by a metric value, colour each bar relative to the max value in the current dataset:

| Range | Colour | Hex |
|---|---|---|
| < 25 % of max | green | `#22c55e` |
| 25 – 75 % of max | blue | `#3b82f6` |
| > 75 % of max | orange | `#f97316` |

Helper: `zoneColor(value, maxValue)` in `client/src/viewer/pages/repository/analytics/HorizontalBarChart.tsx` (exported for tests).

When items are grouped (branch/user), use a flat blue (`#3b82f6`) for all bars — zone coloring only applies to ungrouped (per-session) views.

Always accompany zone-colored bars with a `ZoneLegend` strip showing the three thresholds.

### Exception — bounded-ratio metrics use fixed scope colours, not zones

**Do not zone-colour a metric that is bounded 0–100 %.** Zone colouring is relative to the max value in the current dataset, which only carries meaning for an open-ended quantity (cost, tokens, work time) where "large compared to the others" is the interesting signal. For a bounded ratio the absolute value is already the signal — a low value is simply bad — so a max-relative palette invents thresholds that do not exist and inverts the reading (the *best* item would be coloured orange).

Such a metric instead uses **fixed colours per reported scope**, with a two-swatch scope legend in place of `ZoneLegend`:

| Scope | Colour | Hex |
|---|---|---|
| Root sessions only | blue | `#3b82f6` |
| Root + all recursive descendants | teal | `#14b8a6` |
| Undefined ratio (zero denominator, renders `n/a`) | slate-400 | `#94a3b8` |

Exported once as `CACHE_RATIO_SCOPE_COLORS` in `client/src/viewer/lib/cache-ratio-ui.ts` — never inline the hexes; six files consume them.

Two rules that follow from the same reasoning:

- **Fix the axis at 0–100 %.** Rescaling to the data range exaggerates small differences in a bounded metric.
- **An undefined value is not zero.** A zero denominator renders as a short dashed `n/a` stub at the baseline (or, in Recharts, a `null` value so no bar is drawn) — never a 0 % bar, which reads as "very bad" rather than "no data".

Current instance: the Cache Read Ratio views (`analytics/CacheRatioBarChart.tsx`, `analytics/HorizontalCacheRatioRows.tsx`, `reports/CacheReadRatioChart.tsx`). Apply the same treatment to any future bounded-ratio metric rather than reaching for `zoneColor()`.

---

## Scrollable ranking list with ResizeObserver

When rendering a ranked list of bars whose width depends on available container space:

- Mount a `ResizeObserver` on the container `div` to track `contentRect.width`.
- Store width in local state; default to a safe fallback (e.g. `800`) before first observation.
- Cap bar area: `barAreaWidth = Math.min(800, containerWidth - LABEL_COL_WIDTH - VALUE_COL_WIDTH)`.
- Wrap the list in `flex-1 min-h-0 overflow-y-auto` so it scrolls inside a flex parent without expanding the page.

See `client/src/viewer/pages/repository/analytics/HorizontalBarChart.tsx` for the canonical implementation.

---

## Layout toggle (vertical vs horizontal charts)

`AnalyticsState.layout: 'vertical' | 'horizontal'` is stored in component state and synced to the URL via query param `al` (`al=horizontal`). Default is `'vertical'`.

- `'vertical'` renders the time-bucketed D3 stacked bar charts (per-hour timeline).
- `'horizontal'` renders `HorizontalBarChart` — session/group ranking by the selected metric.

The toggle is a pair of icon buttons (`BarChart2` / `BarChartHorizontal`) rendered in the header controls row of `client/src/viewer/pages/repository/analytics/RepositoryAnalytics.tsx`. Active layout gets `bg-accent` highlight.

---

## Popups and tooltips must never leave the viewport

Every floating surface — hover tooltip, cursor-following popup, chart bubble — renders through
`client/src/viewer/components/ViewportPopover.tsx`. Do not hand-roll another one, and do not
position one yourself with `position: fixed` + `left: x + 12`.

- `ViewportPopover` — for callers that already track an anchor point (the chart tooltips, which
  keep `x`/`y` from `e.clientX`/`e.clientY` in state).
- `HoverPopover` — for a trigger element that should show a popup under the cursor; it does the
  `onMouseMove` / `onMouseLeave` / `onPointerLeave` tracking. Used by `DetailTooltip`,
  `DefinitionTooltip` and `CostBreakdownTooltip`.

It **measures** the box and then places it: preferred side first (below-right of the cursor),
flipped to the other side per axis when that would cross an edge, pinned inside the viewport when
neither side fits. The rule this replaced was a per-tooltip guess at its own width
(`x + 360 > window.innerWidth`) with no vertical handling at all — a wider-than-guessed popup ran
off the right edge, which is exactly what the cost popup did.

Cap the width with the numeric `maxWidth` prop, never a `max-w-*` class: the component sets an
inline `max-width` (the viewport cap), and inline styles beat classes.

---

## Hint/tooltip surfaces must share one visual style

Every hover-triggered surface in this app — a short dotted-underline hint, a chart tooltip, a
richer cursor-following popup — must render with the same **light** style: `bg-popover
text-popover-foreground border border-border shadow-md` (or the `ViewportPopover`/`HoverPopover`
equivalent). There is no "dark bubble" variant anywhere else in the app, so a black tooltip is
always a bug, not a deliberate accent.

- `client/src/viewer/ui/tooltip.tsx`'s `TooltipContent` (Radix-based, used for short
  dotted-underline hints — stat-tile labels, evidence chips, icon hints) defaults its `variant`
  prop to `'light'`. Do not pass `variant="dark"` — that variant exists only for a hard override
  and renders a black bubble that clashes with every other popup/tooltip surface (`ui/popover.tsx`,
  `ui/hover-card.tsx`, `ViewportPopover`/`HoverPopover`), which all use the same light style
  already.
- Bigger, richer floating panels use `ViewportPopover`/`HoverPopover` per the section above — same
  light styling, different mechanism (measures-and-places vs. Radix-positioned).

### Stat-tile hints must be applied uniformly

`SummaryStatTile.tsx`'s optional `hint` prop renders a dotted-underline label with a tooltip
explaining the metric. When one tile in a row of stat tiles (e.g. `SummaryExecutiveBand.tsx`'s
seven-tile row) gets a `hint`, give every tile in that row one — an underline on only one label in
an otherwise-plain row reads as broken, not as "this one has more detail". Keep each hint to 1-2
sentences describing what the metric measures and any non-obvious scope (e.g. "tree-scoped,
including sub-agents"), not a restatement of the label.

---

## Grouped tooltip vs single-session tooltip

`HorizontalBarChart` renders different tooltips based on `groupBy`:

- `groupBy === 'none'`: renders `SessionTooltip` (from `client/src/viewer/pages/repository/analytics/SessionTooltip.tsx`) for the single session behind the bar.
- `groupBy !== 'none'`: renders an inline `GroupTooltip` showing up to 3 sessions from the group with a "+N more" footer. Both are positioned by `ViewportPopover` (see above), not by the chart.

Clicking any bar opens a `SessionModal` (Dialog) listing all sessions in the group; clicking a session inside the modal navigates to that session and closes the modal.
