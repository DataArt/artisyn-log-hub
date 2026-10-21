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

  // Theme tokens (not Tailwind `dark:` variants): `dark:` follows the OS
  // prefers-color-scheme, while the app theme is the `.dark` class — mixing them
  // put dark-palette text on the light card.
  const tone = hasIssues
    ? {
        card: 'bg-warning/10 border-warning/50',
        badge: 'bg-warning',
        title: 'text-foreground',
        body: 'text-muted-foreground',
        button:
          'border-warning/50 bg-background text-foreground hover:bg-warning/15',
      }
    : {
        card: 'bg-success/10 border-success/50',
        badge: 'bg-success',
        title: 'text-foreground',
        body: 'text-muted-foreground',
        button:
          'border-success/50 bg-background text-foreground hover:bg-success/15',
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
