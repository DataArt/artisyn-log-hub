/**
 * Thresholds chip of the OKF verdict card (FR-17): "custom thresholds" with a hover list of the
 * fields that differ from the defaults, or a muted "default thresholds ⚙". Either one opens
 * Settings → Analysis (OKF thresholds) when `onOpenSettings` is given.
 */
import { Settings } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import type { OkfThresholdsInfo } from '../../../../../models/repositories';

export function OkfThresholdsChip({
  thresholds,
  onOpenSettings,
}: {
  thresholds: OkfThresholdsInfo;
  onOpenSettings?: () => void;
}) {
  const custom = thresholds.custom;
  const isCustom = custom.length > 0;
  const className = `inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
    onOpenSettings ? 'hover:bg-accent/60' : ''
  } ${
    isCustom
      ? 'border-amber-500/60 text-amber-700 dark:text-amber-400'
      : 'border-border text-muted-foreground'
  }`;
  const content = (
    <>
      {isCustom ? `custom thresholds · ${custom.length}` : 'default thresholds'}
      <Settings className="size-3" aria-hidden="true" />
    </>
  );
  const dataProps = {
    'data-testid': 'okf-thresholds-chip',
    'data-custom': isCustom ? 'true' : 'false',
  };
  const chip = onOpenSettings ? (
    <button
      type="button"
      {...dataProps}
      onClick={onOpenSettings}
      title={isCustom ? undefined : 'Open Settings → Analysis (OKF thresholds)'}
      className={className}
    >
      {content}
    </button>
  ) : (
    <span {...dataProps} className={className}>
      {content}
    </span>
  );
  if (!isCustom) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="mb-1">Differ from the defaults:</div>
        <ul className="font-mono">
          {custom.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
