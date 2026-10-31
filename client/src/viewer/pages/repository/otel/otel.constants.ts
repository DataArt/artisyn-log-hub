/**
 * Client constants of the OTEL tabs (2026-10-30 otel-tabs-traces, DD-20 polling and the live
 * highlight of Visual/UX notes). The server owns its own copies of the shared session-age
 * threshold (`server/src/logs/otel/otel-facts.constants.ts`).
 */
import type { OtelReasonKey } from '../../../../models/repositories';

/** Session OTEL tab poll interval while the session is live (DD-20). */
export const OTEL_SESSION_POLL_MS = 5_000;

/** Repository and team OTEL tab poll interval while the period includes now (DD-20). */
export const OTEL_REPO_POLL_MS = 30_000;

/** Polling stops when the user gave no input for this long (DD-20); input resumes it. */
export const OTEL_IDLE_STOP_MS = 600_000;

/**
 * A session counts as live while its newest realtime or chunk data is younger than this
 * (the server's `OTEL_SESSION_ENDED_MS`; the session route reports it as `status.live`).
 */
export const OTEL_SESSION_ENDED_MS = 600_000;

/** How long a new / updated row, bar or KPI stays highlighted (Visual/UX notes). */
export const OTEL_HIGHLIGHT_MS = 2_000;

/** How long the transient "Filled N calls / M spans" notice stays up (DD-14). */
export const OTEL_FILLED_NOTICE_MS = 10_000;

/**
 * The lowest hook version that sends realtime batches (DD-15, the server's
 * `OTEL_LIVE_HOOK_MIN_VERSION`); below it the tabs say "Slow updates" and offer an upgrade.
 */
export const OTEL_LIVE_HOOK_MIN_VERSION = '2.29.0';

/** Share bars shown before the rest is folded into "other (N)" (Visual/UX notes). */
export const OTEL_SHARE_TOP = 8;

/** The in-app help article of the OTEL tabs and its section anchors (`user-docs/otel-tab.md`). */
export const OTEL_HELP_SLUG = 'otel-tab';
export const OTEL_HELP_ANCHORS = {
  enable: 'enable-otel-and-traces',
  upgrade: 'upgrade-the-hook-for-live-updates',
  realtime: 'the-realtime-channel',
  hidden: 'hidden-calls',
  imported: 'imported-sessions',
  // 2026-10-30 otel-shared-receiver, DD-31: the reason sections.
  adminManaged: 'admin-managed-otel',
  claudeCodeChange: 'claude-code-21282-change',
  troubleshooting: 'troubleshooting-otel-tab-is-empty',
  tabEmpty: 'otel-tab-is-empty',
} as const;

/**
 * Values of the sessions list `otelReason=` filter: every reason a hook reports plus `no-status`
 * (2026-10-30 otel-shared-receiver, DD-32). Mirrors `OTEL_REASON_FILTER_KEYS` in
 * `server/src/logs/otel/otel-facts.constants.ts`.
 */
export const OTEL_REASON_FILTER_KEYS = [
  'receiver-down',
  'managed-disabled',
  'managed-endpoint',
  'project-only',
  'not-configured',
  'unknown',
  'no-status',
] as const satisfies readonly OtelReasonKey[];

/** A raw `otelReason` value narrowed to a reason key; null when absent or unknown. */
export function parseOtelReasonKey(
  raw: string | null | undefined,
): OtelReasonKey | null {
  return OTEL_REASON_FILTER_KEYS.find((k) => k === raw) ?? null;
}

/** Chip colour of a reason (DD-31): red = organization-managed, amber = user can fix, grey = unknown. */
export type OtelReasonTone = 'red' | 'amber' | 'grey';

export interface OtelReasonMessage {
  tone: OtelReasonTone;
  title: string;
  body: string;
  /** Heading id in `user-docs/otel-tab.md` (`OTEL_HELP_ANCHORS`). */
  helpAnchor: string;
  helpLabel: string;
}

/**
 * Title, body and help link per reason, verbatim from `wireframes/otel-reason-messages.svg`
 * (2026-10-30 otel-shared-receiver, DD-31). Shown in the session tab's reason panel, the partial
 * banner and the coverage chips.
 */
export const OTEL_REASON_MESSAGES: Record<OtelReasonKey, OtelReasonMessage> = {
  'managed-endpoint': {
    tone: 'red',
    title: 'OTEL is managed by your organization',
    body: 'Managed settings send telemetry to another collector. Nothing to fix on your side — only an admin can route it to Log Hub.',
    helpAnchor: OTEL_HELP_ANCHORS.adminManaged,
    helpLabel: 'Admin-managed OTEL',
  },
  'managed-disabled': {
    tone: 'red',
    title: 'Telemetry is disabled by your organization',
    body: 'Managed settings turn Claude Code telemetry off. Everything except OTEL tabs and utility-call cost keeps working.',
    helpAnchor: OTEL_HELP_ANCHORS.adminManaged,
    helpLabel: 'Admin-managed OTEL',
  },
  'project-only': {
    tone: 'amber',
    title: 'OTEL keys are only in project settings',
    body: 'Claude Code 2.1.282+ ignores them there. Re-run the Log Hub installer (it writes ~/.claude/settings.json) and restart Claude Code.',
    helpAnchor: OTEL_HELP_ANCHORS.claudeCodeChange,
    helpLabel: 'Claude Code 2.1.282 change',
  },
  'not-configured': {
    tone: 'amber',
    title: 'OTEL is not configured',
    body: 'No telemetry keys in user settings, or an existing collector was kept ("keep"). Re-run the installer and choose proxy or replace.',
    helpAnchor: OTEL_HELP_ANCHORS.enable,
    helpLabel: 'Enable OTEL',
  },
  'receiver-down': {
    tone: 'amber',
    title: 'The local OTEL receiver was not reachable',
    body: 'Check hook.log and ~/.artisyn/otel/receiver.log (port conflict, crash). A new session usually restarts it.',
    helpAnchor: OTEL_HELP_ANCHORS.troubleshooting,
    helpLabel: 'Troubleshooting',
  },
  unknown: {
    tone: 'grey',
    title: 'No OTEL data — cause not determined',
    body: 'Settings look right but nothing arrived. Run /status or claude doctor and follow the checklist.',
    helpAnchor: OTEL_HELP_ANCHORS.troubleshooting,
    helpLabel: 'Troubleshooting',
  },
  'no-status': {
    tone: 'grey',
    title: 'No OTEL data for this session',
    body: 'This session was uploaded by an older hook that does not report why. Upgrade the hook to see the reason.',
    helpAnchor: OTEL_HELP_ANCHORS.tabEmpty,
    helpLabel: 'OTEL tab is empty',
  },
};

/** Tailwind classes of a reason chip per tone, light and dark (`ui-principles.md`). */
export const OTEL_REASON_CHIP_CLASSES: Record<OtelReasonTone, string> = {
  red: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
  amber:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  grey: 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
};

/**
 * Short chip label of a reason in the coverage banner and the sessions-list filter chip
 * (`wireframes/repo-otel-tab-coverage.svg`): the key itself, `no status (older hook)` for
 * `no-status`.
 */
export function otelReasonShortLabel(key: OtelReasonKey): string {
  return key === 'no-status' ? 'no status (older hook)' : key;
}

/** The chip tooltip: the reason's title and body (DD-31). */
export function otelReasonTooltip(key: OtelReasonKey): string {
  const m = OTEL_REASON_MESSAGES[key];
  return `${m.title}. ${m.body}`;
}

/**
 * "Still works / Not available" lists of the session reason panel, shared by every reason
 * (wireframe `session-otel-tab-no-data.svg`, DD-31).
 */
export const OTEL_STILL_WORKS: readonly string[] = [
  'Sessions, prompts, tools, files',
  'Attribution, change surface',
  'Log Hub-computed cost',
];
export const OTEL_NOT_AVAILABLE: readonly string[] = [
  'OTEL cost chart, traces',
  'Telemetry cost reconciliation',
  'Utility-call cost',
];

/**
 * People shown by name in the team tab's chart legend and cost flow; the rest are folded into
 * "others (N)" (DD-29). The People table lists everyone.
 */
export const OTEL_TEAM_TOP_PEOPLE = 5;
