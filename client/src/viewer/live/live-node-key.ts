/**
 * Client side of the Live view node keys (2026-11-04 otel-live-view, DD-3).
 *
 * The server owns the key grammar (`server/src/logs/otel/otel-live-tree.ts`) and sends the
 * canonical `key` / `type` / ids on every node; the client never parses or builds keys. This
 * module only names the home key and guesses a node type from the `?live=` value before the
 * first answer arrives (e.g. to pick a breadcrumb placeholder).
 */
import type { OtelLiveNodeType } from '../../models/otel-live';

export const HOME_LIVE_KEY = 'home';

const PREFIX_TYPES: readonly [string, OtelLiveNodeType][] = [
  ['team:', 'team'],
  ['repo:', 'repo'],
  ['session:', 'session'],
  ['agent:', 'agent'],
];

/** The node type a key's prefix names; null for anything unrecognised. */
export function liveNodeType(key: string): OtelLiveNodeType | null {
  if (key === HOME_LIVE_KEY) return 'home';
  if (key === 'noteam') return 'noteam';
  for (const [prefix, type] of PREFIX_TYPES) {
    if (key.startsWith(prefix)) return type;
  }
  return null;
}
