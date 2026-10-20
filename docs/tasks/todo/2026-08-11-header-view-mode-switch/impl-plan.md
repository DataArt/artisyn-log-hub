# T-91: Header View Mode Switch — Implementation Plan

## TL;DR

- Pure client change: one new React context (`AppModeContext`), no new deps, no server/API/DB changes.
- New `AppMode` type (`'simple-dev' | 'full-dev' | 'manager'`), distinct from `SessionListPanel.tsx`'s
  unrelated `ViewMode` type.
- Mode persists across reloads via `localStorage` (key `artisyn:appMode`), same pattern as
  `AppShell.tsx`'s `artisyn:leftNavCollapsed`.
- "Simple Dev"/"Manager" show a small "Coming soon" `Badge` in the session list and session detail
  areas; "Full Dev" behavior/UI is unchanged.
- No test changes; visual check only (see Test coverage plan).

## Reference

See [requirements.md](./requirements.md).

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `client/src/viewer/context/AppModeContext.tsx` | **New.** `AppMode` type, `AppModeProvider`, `useAppMode()` hook | Mirrors `context/AuthContext.tsx`'s shape; lazy-init + persist via `localStorage['artisyn:appMode']`, same pattern as `AppShell.tsx`'s `isCollapsed` |
| `client/src/viewer/components/AppShell.tsx` | Wrap `<MainNav />` + content in `<AppModeProvider>` | Provided here (above the router's `AppLayout` content and `MainNav`) so both `MainNav` and the `RepositoryView` subtree can reach it — see requirements' "Common sense considerations" |
| `client/src/viewer/pages/main/MainNav.tsx` | Add the 3-way mode switch control | `ToggleGroup`/`ToggleGroupItem` (`type="single"`, `variant="outline"`, same usage as `SessionExportSection.tsx:152-161`), reading/writing `useAppMode()`; place between the title and the Help button |
| `client/src/viewer/pages/repository/session-list/SessionListPanel.tsx` | Consume `useAppMode()`; show placeholder badge when mode ≠ `'full-dev'` | Add a `Badge` ("Coming soon") in the header block (`SessionListPanel.tsx:140-151`, alongside the mode `<select>`) — `full-dev` renders nothing extra |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | Consume `useAppMode()`; show placeholder badge when mode ≠ `'full-dev'` | Add the same `Badge` next to `SessionDetailHeader` (`SessionDetailPane.tsx:95-100`) — `full-dev` renders nothing extra |
| `docs/knowledgebase/client-component-map.md` | Update component map | Add `context/AppModeContext.tsx` entry; append a short note to the `MainNav.tsx`, `SessionListPanel.tsx`, `SessionDetailPane.tsx` entries |

Both list/detail files already import `Badge` from `'../../ui/badge'` elsewhere in the codebase
(`RepositoryHeader.tsx`) — `SessionListPanel.tsx` is one level deeper, so its import path is
`'../../../ui/badge'`.

## Test coverage plan

No unit tests — this is UI state plumbing plus a `ToggleGroup` control and a static placeholder
badge, matching the pattern of `AppShell.tsx`'s existing (untested) `isCollapsed` persistence.
Visual check only, per the work cycle: confirm the switch appears in the header, defaults to
"Full Dev", switching modes updates the control and shows the "Coming soon" badge in both the
session list and session detail areas, "Full Dev" behavior is pixel-identical to current, and the
selection survives a page reload.

## Visual/UX notes

- Switch options label as "Simple Dev" / "Full Dev" / "Manager" (or shortened `ToggleGroupItem`
  text if space is tight in the header — follow `SessionExportSection.tsx`'s compact single-word
  item labels as precedent).
- Placeholder badge text: "Coming soon" (small, e.g. `variant="secondary"` or `"outline"`), shown
  only when mode is `simple-dev` or `manager`.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Context + header switch | 3 | — |
| 2 | Wire list/detail placeholders + KB update | 3 | — |

### Chunk 1 — Context + header switch
- [ ] Create `client/src/viewer/context/AppModeContext.tsx`: export `AppMode = 'simple-dev' | 'full-dev' | 'manager'`, `AppModeProvider` (lazy-init state from `localStorage.getItem('artisyn:appMode')`, falling back to `'full-dev'` on missing/invalid value, persisting on every change), and `useAppMode()` returning `{ mode, setMode }` (throws if used outside the provider, mirroring `useAuth()`).
- [ ] In `AppShell.tsx`, import `AppModeProvider` and wrap the existing returned JSX (the `<div className="flex flex-col h-screen">...</div>`, which contains `<MainNav />` and `{children}`) in it.
- [ ] In `MainNav.tsx`, import `ToggleGroup`/`ToggleGroupItem` and `useAppMode`; add a `type="single"` `variant="outline"` toggle group with items `simple-dev`/`full-dev`/`manager` (labels "Simple Dev"/"Full Dev"/"Manager"), placed between the title `span` and the Help `Button`, bound to `mode`/`setMode`.

### Chunk 2 — Wire list/detail placeholders + KB update
- [ ] In `SessionListPanel.tsx`, import `useAppMode` and `Badge` from `'../../../ui/badge'`; in the header block (around line 140-151) render `{mode !== 'full-dev' && <Badge variant="secondary">Coming soon</Badge>}` next to the mode `<select>`.
- [ ] In `SessionDetailPane.tsx`, import `useAppMode` and `Badge` from `'../../ui/badge'`; render the same conditional `Badge` next to `<SessionDetailHeader ... />` (around line 95-100).
- [ ] Update `docs/knowledgebase/client-component-map.md`: add an entry for `context/AppModeContext.tsx` under the `viewer/context/` section, and note the new mode-switch/badge wiring in the existing `MainNav.tsx`, `SessionListPanel.tsx`, and `SessionDetailPane.tsx` entries.
