/**
 * Detector subsystem shared types.
 *
 * A `Detector` inspects a session's parsed logs and derived figures and returns at most one
 * `Finding`, or `null` when its condition does not fire or its input is absent
 * (detectors stay simplistic: no fallback substitution, no heuristic scoring).
 */
import type { ModelPricingMap } from '../../../../../../models/pricing';
import type { ParsedSession } from '../../types';
import type { SessionInfoDerived } from '../../session-info-derive';
import type { SessionTab } from '../../../useRepositoryViewState';
import type { SessionSummaryDerived } from '../session-summary-derive';
import type { ReleaseVersionsAtStart } from '../../../../../lib/release-versions';

/** `success` is a positive, sorts-last finding (claude-version "newer was available"). */
export type FindingSeverity = 'critical' | 'warning' | 'info' | 'success';

/**
 * A finding's optional call to action. Only `kind: 'tab'` exists:
 * the row renders a right-aligned link that switches the session view to `tab`. Kept as a
 * discriminated union so a later action kind (a URL, a dialog) is additive rather than a
 * breaking widening of the field.
 */
export interface FindingTabAction {
  kind: 'tab';
  tab: SessionTab;
  label: string;
}

export interface Finding {
  /** detector id, unique per session */
  id: string;
  severity: FindingSeverity;
  title: string;
  /** one line */
  explanation: string;
  /** pre-formatted monospace chips */
  evidence?: string[];
  /** 1-based global user-event index (`turn.index`) */
  turnIndex?: number;
  /**
   * Optional section label. Ungrouped findings render first, in
   * severity order; every distinct `group` then gets one labelled section, in first-appearance
   * order. An empty group renders nothing at all (no "all clear" placeholder).
   */
  group?: string;
  /**
   * Optional right-aligned action link. Independent of `turnIndex`:
   * a whole-session finding (the change-surface family) has no originating turn but still has
   * somewhere useful to send the reader.
   */
  action?: FindingTabAction;
}

export interface DetectorContext {
  parsedLogs: ParsedSession;
  pricing: ModelPricingMap | undefined;
  info: SessionInfoDerived;
  summary: SessionSummaryDerived;
  /** Claude Code stable/latest releases current at session start; `null` when unknown. */
  releaseVersions: ReleaseVersionsAtStart | null;
  /** Highest Claude Code version recorded on the session; `null` when unknown. */
  sessionVersion: string | null;
}

export interface Detector {
  id: string;
  run(ctx: DetectorContext): Finding | null;
}
