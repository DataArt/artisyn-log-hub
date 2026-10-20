import type { ParsedSession } from './types';
import { formatInt, formatBytes, formatCompact } from './log-parser';
import { formatCost } from '../../../lib/format';
import { formatImageToolLabel } from './prompt-turn-helpers';
import { CollapsibleSection, InfoRow } from './session-info-primitives';

interface Props {
  parsedLogs: ParsedSession | null;
  imageCost: number | null;
  imageSources: { toolName: string; count: number }[];
}

/**
 * Session Info tab — "Vision" collapsible section: image count, per-tool
 * sources, total size, estimated input tokens/cost, and average tokens per
 * image. Renders nothing when the session examined no images. Extracted
 * from `SessionInfoTab.tsx` to keep that file under the project's
 * component-size guidance.
 */
export function SessionInfoVisionSection({
  parsedLogs,
  imageCost,
  imageSources,
}: Props) {
  if ((parsedLogs?.summary.imageStats.count ?? 0) === 0) return null;

  return (
    <CollapsibleSection title="Vision">
      <InfoRow label="Images examined">
        {parsedLogs ? formatInt(parsedLogs.summary.imageStats.count) : '—'}
      </InfoRow>
      {imageSources.length > 0 && (
        <InfoRow label="Sources">
          <span className="whitespace-pre-wrap">
            {imageSources
              .map(
                ({ toolName, count }) =>
                  `${formatImageToolLabel(toolName)}${count > 1 ? ` ×${count}` : ''}`,
              )
              .join('\n')}
          </span>
        </InfoRow>
      )}
      <InfoRow label="Total image size">
        {parsedLogs
          ? formatBytes(parsedLogs.summary.imageStats.totalBytes)
          : '—'}
      </InfoRow>
      <InfoRow label="Est. input tokens">
        {parsedLogs && parsedLogs.summary.imageStats.estInputTokens > 0
          ? `~${formatInt(parsedLogs.summary.imageStats.estInputTokens)}`
          : parsedLogs
            ? '—'
            : '—'}
      </InfoRow>
      <InfoRow label="Est. vision cost">
        {imageCost != null ? `~${formatCost(imageCost)}` : '—'}
      </InfoRow>
      {parsedLogs && parsedLogs.summary.imageStats.count > 0 && (
        <InfoRow label="Avg tokens/image">
          {parsedLogs.summary.imageStats.estInputTokens > 0
            ? `~${formatCompact(Math.round(parsedLogs.summary.imageStats.estInputTokens / parsedLogs.summary.imageStats.count))}`
            : '—'}
        </InfoRow>
      )}
    </CollapsibleSection>
  );
}
