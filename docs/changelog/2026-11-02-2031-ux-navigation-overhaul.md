# Navigation overhaul: Home page, All views map, one row of session tabs

- New Home page (top-bar **Home**, left): your repositories with question shortcuts, what needs
  attention, this week's cost, pinned views and recent sessions, in calm per-widget colours.
- **All views** (top bar or Ctrl/Cmd+K): every screen, tab, report and help article in one tree
  with a synonym-aware filter and a context panel for team / repository / session.
- Session tabs are one row with a **View** select (What happened, Cost, Harness & context, Failed
  tool call, All tabs); every other tab is under **More**. Each chart (Dashboard, Context Growth,
  Call Tree, Timeline, …) is now a tab of its own; old `tab=charts` links still work.
- Summary ends with "Where to look next" cards; every tab bar shows a one-line description on hover.
- Uploads hit by a transient database error (e.g. a deadlock) are retried instead of being
  reported as a broken file, and a server-side failure no longer blames the hook.
- Team pages scroll again on short windows.
