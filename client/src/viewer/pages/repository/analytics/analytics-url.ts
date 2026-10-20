import type { AnalyticsState } from './analytics-state';

// Builds Partial<AnalyticsState> from the current URL search params.
export function analyticsFromParams(
  p: URLSearchParams,
): Partial<AnalyticsState> {
  const out: Partial<AnalyticsState> = {};
  const ar = p.get('ar');
  if (ar) out.range = ar as AnalyticsState['range'];
  const af = p.get('af');
  if (af) out.customFrom = af;
  const at = p.get('at');
  if (at) out.customTo = at;
  const ag = p.get('ag');
  // `attr:<key>` round-trips the same way report-url.ts's `groupBy`
  // parsing does — an empty key after the prefix falls back like any other value.
  if (ag === 'branch' || ag === 'user') out.groupBy = ag;
  else if (ag != null && ag.startsWith('attr:') && ag.length > 5)
    out.groupBy = ag as `attr:${string}`;
  const abs = p.get('abs');
  if (abs) out.branches = abs.split(',').map(decodeURIComponent);
  const aus = p.get('aus');
  if (aus) out.users = aus.split(',').map(decodeURIComponent);
  const av = p.get('av');
  // Keep this whitelist in sync with `applyAnalyticsToParams` below and with
  // `AnalyticsState['view']`: a value written to `av` but missing here silently
  // falls back to `work-time` (that was the case for `log-lines`).
  if (
    av === 'work-time' ||
    av === 'cost' ||
    av === 'files' ||
    av === 'vision' ||
    av === 'mcp' ||
    av === 'productivity' ||
    av === 'log-lines' ||
    av === 'cache-read-ratio' ||
    // usage analytics
    av === 'tools' ||
    av === 'tokens' ||
    av === 'productivity-counters' ||
    av === 'active-sessions' ||
    // change surface
    av === 'change-surface'
  )
    out.view = av;
  const al = p.get('al');
  if (al === 'horizontal') out.layout = 'horizontal';
  return out;
}

// Writes AnalyticsState fields into a URLSearchParams, keeping other params intact.
export function applyAnalyticsToParams(
  state: AnalyticsState,
  p: URLSearchParams,
): void {
  p.set('mtab', 'analytics');
  if (state.range !== '1d') p.set('ar', state.range);
  else p.delete('ar');
  if (state.customFrom) p.set('af', state.customFrom);
  else p.delete('af');
  if (state.customTo) p.set('at', state.customTo);
  else p.delete('at');
  if (state.groupBy && state.groupBy !== 'none') p.set('ag', state.groupBy);
  else p.delete('ag');
  // Values are joined raw, not pre-encoded: URLSearchParams already
  // percent-encodes when serialized to a string, so calling encodeURIComponent
  // here first would double-encode (e.g. "dt@x.com" -> "dt%2540x.com" instead
  // of "dt%40x.com"). decodeURIComponent on read is a safe no-op either way.
  if (state.branches.length > 0) p.set('abs', state.branches.join(','));
  else p.delete('abs');
  if (state.users.length > 0) p.set('aus', state.users.join(','));
  else p.delete('aus');
  if (state.view && state.view !== 'work-time') p.set('av', state.view);
  else p.delete('av');
  if (state.layout === 'horizontal') p.set('al', 'horizontal');
  else p.delete('al');
}
