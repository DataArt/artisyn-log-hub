/**
 * Detector registry.
 *
 * `DETECTORS`' declaration order is the registration order: compression, ceiling pressure,
 * low cache-read ratio, then the three change-surface detectors, then the Claude Code
 * version check. `SEVERITY_RANK` orders critical, warning, info,
 * then success last. Adding a detector touches
 * only this file plus the new detector file.
 *
 * Registration order is also the tie-break inside a severity level (the sort below is stable),
 * and — via `Finding.group` — the order `SummaryDetectedIssues` discovers its sections in.
 */
import { contextCompressionDetector } from './context-compression';
import { contextCeilingPressureDetector } from './context-ceiling-pressure';
import { lowCacheReadRatioDetector } from './low-cache-read-ratio';
import { changeSurfaceSpreadDetector } from './change-surface-spread';
import { changeSurfaceModulesDetector } from './change-surface-modules';
import { changeSurfaceSingleFileFoldersDetector } from './change-surface-single-file-folders';
import { claudeVersionDetector } from './claude-version';
import type {
  Detector,
  DetectorContext,
  Finding,
  FindingSeverity,
} from './types';

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

export const DETECTORS: Detector[] = [
  contextCompressionDetector,
  contextCeilingPressureDetector,
  lowCacheReadRatioDetector,
  changeSurfaceSpreadDetector,
  changeSurfaceModulesDetector,
  changeSurfaceSingleFileFoldersDetector,
  claudeVersionDetector,
];

/**
 * Runs every registered detector, drops `null`s, and sorts by severity using a stable sort on
 * the registration-ordered array — equal severities keep registration order.
 */
export function runDetectors(ctx: DetectorContext): Finding[] {
  const findings = DETECTORS.map((detector) => detector.run(ctx)).filter(
    (finding): finding is Finding => finding !== null,
  );
  return findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}
