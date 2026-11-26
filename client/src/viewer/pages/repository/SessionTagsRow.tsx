import { AlertTriangle } from 'lucide-react';
import type { SessionTag, SessionTagNoise } from '../../../models/repositories';
import { noisySessionKeyHint, TAG_LIMIT_HINT } from '../../lib/session-tags';

const SOURCE_LABEL: Record<SessionTag['source'], string> = {
  otel: 'OTEL resource attributes',
  config: 'hook config (migrated context)',
};

/**
 * The session header's TAGS row (2026-11-24 otel-session-tags, FR-5 / FR-10): one `key=value`
 * chip per tag of the root session, then one warning line per noisy key and one for the
 * 500-pair limit. Renders nothing when the session has no tags and no warning (AC-5). Tag text
 * goes through React text nodes only — never HTML.
 */
export function SessionTagsRow({
  tags,
  tagNoise,
}: {
  tags: readonly SessionTag[] | undefined;
  tagNoise: SessionTagNoise | undefined;
}) {
  const list = tags ?? [];
  const noisy = tagNoise?.noisyKeys ?? [];
  const atLimit = tagNoise?.atLimit === true;
  if (list.length === 0 && noisy.length === 0 && !atLimit) return null;

  return (
    <div className="flex w-full flex-col gap-1" data-testid="session-tags-row">
      {list.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Tags
          </span>
          {list.map((tag) => (
            <span
              key={`${tag.key}\u0000${tag.value}`}
              data-testid="session-tag-chip"
              title={`${tag.key}=${tag.value}\nsource: ${tag.source} (${SOURCE_LABEL[tag.source]})`}
              className="inline-flex max-w-[24rem] items-center rounded px-1.5 py-0.5 font-mono text-xs bg-violet-500/10 text-violet-700 dark:text-violet-400"
            >
              <span className="shrink-0">{tag.key}</span>
              <span className="shrink-0 text-muted-foreground">=</span>
              <span className="min-w-0 truncate">{tag.value}</span>
            </span>
          ))}
        </div>
      )}
      {noisy.map((n) => (
        <p
          key={n.key}
          data-testid="session-tag-noisy-warning"
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {noisySessionKeyHint(n.key, n.values)}
          </span>
        </p>
      ))}
      {atLimit && (
        <p
          data-testid="session-tag-limit-warning"
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{TAG_LIMIT_HINT}</span>
        </p>
      )}
    </div>
  );
}
