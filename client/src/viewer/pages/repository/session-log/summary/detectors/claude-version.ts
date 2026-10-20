/**
 * Claude Code version check detector: `claude-version`.
 *
 * Compares the session's Claude Code version against the npm `stable` / `latest` dist-tags
 * that were current when the session started (`ctx.releaseVersions`):
 * - `v < stable`           → `critical` "Outdated Claude Code version"
 * - `stable <= v < latest` → `success`  "Newer Claude Code was available: <latest>"
 * - `v >= latest`, or any input missing / unparseable → no finding.
 *
 * A whole-session finding: no `turnIndex`, `action` or `group`.
 */
import { compareVersions, parseVersion } from '../../../../../lib/semver';
import type { Detector, Finding } from './types';

export const OUTDATED_TITLE = 'Outdated Claude Code version';

export function OUTDATED_EXPLANATION(v: string, stable: string): string {
  return `Claude Code ${v} was older than the stable release ${stable} when this session started.`;
}

export function NEWER_TITLE(latest: string): string {
  return `Newer Claude Code was available: ${latest}`;
}

export function NEWER_EXPLANATION(v: string, stable: string): string {
  return `This session ran on ${v}, which was at or above stable ${stable} at session start.`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `yyyy-mm-dd hh:mm` in local time, zero-padded; the raw string when unparseable. */
function formatLocalMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const claudeVersionDetector: Detector = {
  id: 'claude-version',
  run(ctx): Finding | null {
    const { sessionVersion, releaseVersions } = ctx;
    if (sessionVersion == null || releaseVersions == null) return null;
    if (parseVersion(sessionVersion) == null) return null;
    const { stable, latest, effectiveFrom } = releaseVersions;
    if (parseVersion(stable) == null || parseVersion(latest) == null)
      return null;

    const v = sessionVersion.trim();
    const evidence = [
      `session ${v}`,
      `stable ${stable}`,
      `latest ${latest}`,
      `releases as of ${formatLocalMinute(effectiveFrom)}`,
    ];

    if (compareVersions(v, stable) < 0) {
      return {
        id: 'claude-version',
        severity: 'critical',
        title: OUTDATED_TITLE,
        explanation: OUTDATED_EXPLANATION(v, stable),
        evidence,
      };
    }
    if (compareVersions(v, latest) < 0) {
      return {
        id: 'claude-version',
        severity: 'success',
        title: NEWER_TITLE(latest),
        explanation: NEWER_EXPLANATION(v, stable),
        evidence,
      };
    }
    return null;
  },
};
