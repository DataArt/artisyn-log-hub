/**
 * Shared UI constants and formatting for the change-surface metric.
 *
 * `concentration` is a **bounded** 0–100 score, so per `ui-principles.md` it uses a fixed axis and fixed per-band colours — never `zoneColor()`, which is
 * relative to a dataset max and would paint the most focused session orange. The five surfaces
 * that render the metric (the Summary tile, the Change surface tab, the analytics chart, the
 * report and its PDF) all import from here instead of inlining hexes or re-deriving a band.
 *
 * The server computes `band` alongside `concentration` (one set of thresholds), and the printed
 * `≥ 60` / `40–59` / `< 40` legend copy below is display text describing that server rule. The
 * one place a band is re-derived from a number is `zoneOf` (the Analytics chart's bar colour,
 * whose buckets carry no `band`); it is held to the server rule by
 * `change-surface-ui.algo.test.ts`, which runs the same doc rows.
 */
import type { ChangeBand } from '../../models/repositories';

/** What a genuinely absent (not zero) change-surface value renders as. */
export const CHANGE_SURFACE_NA = 'n/a';

/** Human labels for the three bands. */
export const CHANGE_BAND_LABELS: Record<ChangeBand, string> = {
  focused: 'focused',
  mixed: 'mixed',
  scattered: 'scattered',
};

/**
 * Fixed colours per band — green/blue/orange, matching the semantic direction of the other
 * bounded-ratio surfaces in the app (good → green). Consumed by the D3 chart and by the
 * Summary tile's meter, which need a raw colour rather than a class.
 */
export const CHANGE_BAND_COLORS: Record<ChangeBand, string> = {
  focused: '#22c55e',
  mixed: '#3b82f6',
  scattered: '#f97316',
};

/** Slate-400 — a bucket with zero changed files, which renders `n/a` and no bar. */
export const CHANGE_BAND_UNDEFINED_COLOR = '#94a3b8';

/** Tailwind text colour per band, for the label beside a value. */
export const CHANGE_BAND_TEXT_CLASSES: Record<ChangeBand, string> = {
  focused: 'text-green-600',
  mixed: 'text-blue-600',
  scattered: 'text-orange-600',
};

/** Tailwind background colour per band, for meters and legend swatches. */
export const CHANGE_BAND_BG_CLASSES: Record<ChangeBand, string> = {
  focused: 'bg-green-500',
  mixed: 'bg-blue-500',
  scattered: 'bg-orange-500',
};

/**
 * Legend copy for the three bands. The range text describes the server's fixed thresholds; it
 * is never used to compute anything.
 */
export const CHANGE_BAND_LEGEND: readonly {
  band: ChangeBand;
  label: string;
  range: string;
}[] = [
  { band: 'focused', label: 'focused', range: '≥ 60' },
  { band: 'mixed', label: 'mixed', range: '40–59' },
  { band: 'scattered', label: 'scattered', range: '< 40' },
];

/** The concentration axis is fixed 0–100 everywhere, never scaled to the data. */
export const CONCENTRATION_AXIS_MAX = 100;

/**
 * Display-only reference zones of the Analytics change-surface chart: the same fixed boundaries
 * the shared legend copy prints (`>= 60` / `40-59` / `< 40`), used to position the shaded
 * background and to colour each bar (`zoneOf` below) so a bar visually matches the zone it sits
 * in. A client twin of the server's `concentrationBand` (the analytics bucket carries no `band`);
 * both are tested against docs/knowledgebase/algorithms/change-surface-concentration.md.
 */
export const BAND_ZONES = [
  { band: 'scattered', from: 0, to: 40 },
  { band: 'mixed', from: 40, to: 60 },
  { band: 'focused', from: 60, to: CONCENTRATION_AXIS_MAX },
] as const;

/**
 * Which `BAND_ZONES` entry a concentration score falls in, for the bar's own fill colour.
 * Checked highest-`from`-first so `value === CONCENTRATION_AXIS_MAX` still lands in `focused`
 * (its zone's `to` is the exclusive axis max, not a match boundary).
 */
export function zoneOf(value: number): (typeof BAND_ZONES)[number] {
  for (let i = BAND_ZONES.length - 1; i >= 0; i--) {
    if (value >= BAND_ZONES[i].from) return BAND_ZONES[i];
  }
  return BAND_ZONES[0];
}

/** The band's colour, or the undefined-value slate when the scope has no changed files. */
export function bandColor(band: ChangeBand | null): string {
  return band === null ? CHANGE_BAND_UNDEFINED_COLOR : CHANGE_BAND_COLORS[band];
}

/** The band's label, or `n/a`. */
export function bandLabel(band: ChangeBand | null): string {
  return band === null ? CHANGE_SURFACE_NA : CHANGE_BAND_LABELS[band];
}

/** The band's Tailwind text colour, or muted for `n/a`. */
export function bandTextClass(band: ChangeBand | null): string {
  return band === null
    ? 'text-muted-foreground'
    : CHANGE_BAND_TEXT_CLASSES[band];
}

/** The band's Tailwind fill, or muted for `n/a`. */
export function bandBgClass(band: ChangeBand | null): string {
  return band === null
    ? 'bg-muted-foreground/40'
    : CHANGE_BAND_BG_CLASSES[band];
}

/** `31 / 100`, or `n/a` when the scope changed nothing. Never `0 / 100`. */
export function formatConcentration(value: number | null): string {
  return value === null
    ? CHANGE_SURFACE_NA
    : `${value} / ${CONCENTRATION_AXIS_MAX}`;
}

/** `31`, or `n/a` — the bare score, for compact cells. */
export function formatConcentrationValue(value: number | null): string {
  return value === null ? CHANGE_SURFACE_NA : String(value);
}

/** A count. Absent (`null`) is `n/a`; a real `0` stays `0`. */
export function formatSurfaceCount(value: number | null): string {
  return value === null ? CHANGE_SURFACE_NA : value.toLocaleString();
}

/** A fractional metric at a fixed precision; `null` → `n/a`. */
export function formatSurfaceDecimal(value: number | null, digits = 1): string {
  return value === null ? CHANGE_SURFACE_NA : value.toFixed(digits);
}

/** A `[0, 1]` share as a whole percentage; `null` → `n/a`. */
export function formatSurfaceShare(value: number | null): string {
  return value === null ? CHANGE_SURFACE_NA : `${Math.round(value * 100)}%`;
}

/** `6.4 hops`; `null` → `n/a`. */
export function formatPathDistance(value: number | null): string {
  return value === null ? CHANGE_SURFACE_NA : `${value.toFixed(1)} hops`;
}

/** `depth 3`; `null` → `n/a`. */
export function formatAncestorDepth(value: number | null): string {
  return value === null ? CHANGE_SURFACE_NA : `depth ${value}`;
}

/** `+759` / `−45` — an explicit sign, and a real minus sign for removals. */
export function formatLinesAdded(value: number): string {
  return `+${value.toLocaleString()}`;
}

export function formatLinesRemoved(value: number): string {
  return `−${value.toLocaleString()}`;
}

/** `(no ext)` for an extensionless file, otherwise `.ts`. */
export function formatExtension(extension: string | null): string {
  if (extension === null || extension === '') return '(no ext)';
  return `.${extension}`;
}
