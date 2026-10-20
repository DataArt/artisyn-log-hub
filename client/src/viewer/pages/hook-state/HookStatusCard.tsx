import { Check, Copy } from 'lucide-react';
import type { HookStateDetail } from '../../../models/hook-state';
import { formatRelativeDate } from '../../../lib/format';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

// Reuses the exact `npx ... upgrade` command construction from
// pages/api-keys/InstallTab.tsx (UpgradeHooksCard), keyed off the server-reported
// latest known hook version instead of a separate /static/installer-version.json fetch.
function buildUpgradeCmd(latestVersion: string | null): string {
  const versionSuffix = latestVersion ? `?v=${latestVersion}` : '';
  return `npx "${window.location.origin}/static/artisyn-hooks-installer.tgz${versionSuffix}" upgrade`;
}

export function HookStatusCard({
  detail,
  hasIssues,
}: {
  detail: HookStateDetail;
  hasIssues: boolean;
}) {
  const upgradeCmd = buildUpgradeCmd(detail.latestVersion);
  const { copied, copy } = useCopyToClipboard(upgradeCmd);

  const statusLabel = detail.outdated
    ? `Hook outdated${
        detail.recommendations.length > 0
          ? `, ${detail.recommendations.length} recommendation${detail.recommendations.length > 1 ? 's' : ''}`
          : ''
      }`
    : hasIssues
      ? 'Hook has open issues'
      : 'Hook up to date';

  const tone = hasIssues
    ? {
        card: 'bg-orange-50 dark:bg-orange-950/20 border-orange-300 dark:border-orange-900',
        badge: 'bg-orange-500',
        title: 'text-orange-900 dark:text-orange-300',
        body: 'text-orange-800 dark:text-orange-400',
        button:
          'border-orange-300 dark:border-orange-900 bg-white dark:bg-transparent text-orange-700 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-950/30',
      }
    : {
        card: 'bg-green-50 dark:bg-green-950/20 border-green-300 dark:border-green-900',
        badge: 'bg-green-500',
        title: 'text-green-900 dark:text-green-300',
        body: 'text-green-800 dark:text-green-400',
        button:
          'border-green-300 dark:border-green-900 bg-white dark:bg-transparent text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-950/30',
      };

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-4 rounded-md border p-4 ${tone.card}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${tone.badge}`}
        >
          {hasIssues ? '!' : '✓'}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={`text-sm font-semibold ${tone.title}`}>
            {statusLabel}
          </span>
          <span className={`text-xs ${tone.body}`}>
            Installed version {detail.hookVersion}
            {detail.latestVersion
              ? ` • Latest version ${detail.latestVersion}`
              : ''}
          </span>
          <span className={`text-xs ${tone.body}`}>
            Last activity:{' '}
            {detail.lastActivity
              ? formatRelativeDate(detail.lastActivity)
              : '—'}
          </span>
        </div>
      </div>

      <button
        onClick={copy}
        title={upgradeCmd}
        className={`flex shrink-0 items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors ${tone.button}`}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {copied ? 'Copied!' : 'Copy upgrade cmd'}
      </button>
    </div>
  );
}
