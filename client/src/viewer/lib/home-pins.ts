/**
 * Home pins (DD-17): repositories, Analytics views and reports the viewer pinned to Home.
 *
 * Stored server-side as the user setting `home.pins` (the user-settings endpoint keeps the value
 * as an opaque string, so an older client simply ignores it). Value:
 * `{v:1, items:[{kind:'repo'|'view', repoId, teamId?, view?, addedAt}]}` where `view` is
 * `analytics:<av>` or `report:<id>` and `addedAt` an ISO timestamp. Newest first, at most
 * `PINS_LIMIT` items.
 *
 * Pure: no React, no network. The hook lives in `useHomePins.ts`.
 */

export const PINS_SETTING_KEY = 'home.pins';
export const PINS_LIMIT = 50;

export type PinKind = 'repo' | 'view';

export interface Pin {
  kind: PinKind;
  repoId: number;
  teamId?: number;
  /** `analytics:<av>` or `report:<id>`; only on `kind: 'view'`. */
  view?: string;
  /** ISO timestamp; set by `togglePin` when absent. */
  addedAt?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

const VIEW_RE = /^(analytics|report):[a-z0-9-]+$/;

function parseItem(raw: unknown): Pin | null {
  if (!isRecord(raw)) return null;
  const repoId = positiveInt(raw.repoId);
  if (repoId === undefined) return null;
  const teamId = positiveInt(raw.teamId);
  const addedAt = typeof raw.addedAt === 'string' ? raw.addedAt : undefined;
  const base: Pin = { kind: 'repo', repoId };
  if (teamId !== undefined) base.teamId = teamId;
  if (addedAt !== undefined) base.addedAt = addedAt;
  if (raw.kind === 'repo') return base;
  if (raw.kind === 'view') {
    if (typeof raw.view !== 'string' || !VIEW_RE.test(raw.view)) return null;
    return { ...base, kind: 'view', view: raw.view };
  }
  return null;
}

/**
 * Parses a stored value: the JSON string of the setting, or the already decoded object. An
 * unknown `v`, an unknown `kind` or a malformed item is skipped; the list is capped at
 * `PINS_LIMIT` and deduplicated.
 */
export function parsePins(raw: unknown): Pin[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.items)) {
    return [];
  }
  const out: Pin[] = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    const pin = parseItem(item);
    if (pin === null) continue;
    const key = pinKey(pin);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pin);
    if (out.length >= PINS_LIMIT) break;
  }
  return out;
}

/** The identity of a pin: kind, repository, team and view (`addedAt` is not part of it). */
export function pinKey(pin: Pin): string {
  return [
    pin.kind,
    pin.repoId,
    pin.teamId ?? '',
    pin.kind === 'view' ? (pin.view ?? '') : '',
  ].join('|');
}

export function isPinned(pins: readonly Pin[], pin: Pin): boolean {
  const key = pinKey(pin);
  return pins.some((p) => pinKey(p) === key);
}

/**
 * Adds `pin` to the front (with `addedAt` = `now` when it has none) or removes it when it is
 * already pinned. The result stays within `PINS_LIMIT` (the oldest pins drop off).
 */
export function togglePin(
  pins: readonly Pin[],
  pin: Pin,
  now: Date = new Date(),
): Pin[] {
  const key = pinKey(pin);
  if (pins.some((p) => pinKey(p) === key)) {
    return pins.filter((p) => pinKey(p) !== key);
  }
  const added: Pin = { ...pin, addedAt: pin.addedAt ?? now.toISOString() };
  if (added.kind === 'repo') delete added.view;
  return [added, ...pins].slice(0, PINS_LIMIT);
}

/** The setting value (a JSON string) for `pins`. */
export function serializePins(pins: readonly Pin[]): string {
  return JSON.stringify({
    v: 1,
    items: pins.slice(0, PINS_LIMIT).map((p) => {
      const item: Record<string, unknown> = { kind: p.kind, repoId: p.repoId };
      if (p.teamId !== undefined) item.teamId = p.teamId;
      if (p.kind === 'view' && p.view !== undefined) item.view = p.view;
      if (p.addedAt !== undefined) item.addedAt = p.addedAt;
      return item;
    }),
  });
}
