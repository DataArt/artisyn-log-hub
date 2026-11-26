import { AlertTriangle } from 'lucide-react';
import type { SessionTagValues } from '../../../models/repositories';
import { PinToggle } from '../../components/PinToggle';
import { noisyKeyHint } from '../../lib/session-tags';

/** Values shown inline per tag key; the rest are counted and listed in the chip's tooltip. */
const INLINE_TAG_VALUES = 3;

export interface RepositoryHeaderProps {
  repoUrl: string | undefined;
  sessionCountDisplay: React.ReactNode;
  userCountDisplay: React.ReactNode;
  /**
   * FR-8 tag discovery over the sessions this view shows (2026-11-24 otel-session-tags); one
   * chip per key. `undefined` while loading or on error renders no chips.
   */
  repoTagValues: SessionTagValues | undefined;
  /** The repository to pin to Home (FR-F3); its team when opened from a team route. */
  repoId: number;
  teamId?: number;
}

export function RepositoryHeader({
  repoUrl,
  sessionCountDisplay,
  userCountDisplay,
  repoTagValues,
  repoId,
  teamId,
}: RepositoryHeaderProps) {
  const tagEntries = Object.entries(repoTagValues?.tags ?? {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const noisy = new Set(repoTagValues?.noisyKeys ?? []);
  return (
    <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3 shrink-0">
      {/* No access-mode badge here: `AccessModeBadge` in `MainNav` already covers
          the `/teams/:teamId/repos/:repoId` route, and exactly one such badge
          renders per route. */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <p className="text-sm font-mono min-w-0 truncate">{repoUrl ?? '—'}</p>
        <PinToggle pin={{ kind: 'repo', repoId, teamId }} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          Sessions: {sessionCountDisplay}
        </span>
        <span className="flex items-center gap-1">
          Users: {userCountDisplay}
        </span>
        {tagEntries.map(([key, buckets]) => {
          const values = buckets.map((b) => b.value);
          const shown = values.slice(0, INLINE_TAG_VALUES);
          const more = values.length - shown.length;
          const isNoisy = noisy.has(key);
          const title = [
            `Tag ${key}: ${buckets.map((b) => `${b.value} (${b.sessionCount} sessions)`).join(', ')}`,
            isNoisy ? noisyKeyHint(key) : null,
          ]
            .filter((t): t is string => t !== null)
            .join('\n');
          return (
            <span
              key={key}
              data-testid="repo-tag-chip"
              title={title}
              className="flex max-w-[28rem] items-center gap-1"
            >
              {isNoisy && (
                <AlertTriangle
                  className="size-3.5 shrink-0 text-amber-500"
                  aria-label="Noisy tag key"
                />
              )}
              <span className="shrink-0 font-medium text-foreground/70">
                {key}:
              </span>
              <span className="min-w-0 truncate font-mono">
                {shown.join(', ')}
              </span>
              {more > 0 && <span className="shrink-0 text-xs">+{more}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
