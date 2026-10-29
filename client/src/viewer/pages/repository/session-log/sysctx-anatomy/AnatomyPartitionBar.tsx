// The proportional bar of the "System context anatomy" tab (impl-plan DD 13–15): one segment
// per non-empty partition, width = share, a minimum width for tiny shares, in-segment labels
// when wide enough, a tooltip per segment, hatched Harness internals and a dashed outline when
// the total is unknown.
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type { AnatomyPartition, SysctxAnatomy } from './sysctx-anatomy';
import {
  KIND_COLORS,
  LABEL_MIN_PX,
  MIN_SEGMENT_PX,
  MIN_SHARE_FOR_NATURAL,
  type AnatomyPartitionKind,
} from './sysctx-anatomy-constants';
import { fmtInt, fmtShare, InternalsHintContent } from './AnatomyCells';

const HATCH =
  'repeating-linear-gradient(45deg, #cbd5e1 0, #cbd5e1 6px, #f1f5f9 6px, #f1f5f9 12px)';

/** A partition is drawn only when it has a size (DD 6); internals are a token difference. */
function isDrawn(p: AnatomyPartition): boolean {
  return p.kind === 'harness-internals' ? p.tokens > 0 : (p.bytes ?? 0) > 0;
}

/** Width of the bar container in px, tracked with a ResizeObserver (0 until measured). */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function SegmentTooltip({
  p,
  anatomy,
}: {
  p: AnatomyPartition;
  anatomy: SysctxAnatomy;
}) {
  if (p.kind === 'harness-internals' && anatomy.total !== null) {
    return (
      <InternalsHintContent
        internals={p.tokens}
        share={p.share}
        total={anatomy.total}
        attributed={anatomy.attributed}
      />
    );
  }
  return (
    <div className="space-y-0.5 text-xs">
      <div className="font-medium text-foreground">{p.label}</div>
      <div className="tabular-nums">≈ {fmtInt(p.tokens)} tokens</div>
      {p.bytes !== null && (
        <div className="tabular-nums">{fmtInt(p.bytes)} bytes</div>
      )}
      <div className="tabular-nums">{fmtShare(p.share)}</div>
      {p.estimated && <div className="text-muted-foreground">estimated</div>}
    </div>
  );
}

export interface AnatomyPartitionBarProps {
  anatomy: SysctxAnatomy;
  selectedKind: AnatomyPartitionKind | null;
  onSelect: (kind: AnatomyPartitionKind) => void;
}

export function AnatomyPartitionBar({
  anatomy,
  selectedKind,
  onSelect,
}: AnatomyPartitionBarProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const segments = anatomy.partitions.filter(isDrawn);
  const unknownTotal = anatomy.flags.unknownTotal;

  return (
    <TooltipProvider delayDuration={150}>
      <div
        ref={ref}
        data-testid="anatomy-bar"
        data-unknown-total={unknownTotal ? 'true' : undefined}
        className={cn(
          'flex h-7 w-full gap-px overflow-hidden rounded-md bg-white',
          unknownTotal &&
            'outline-2 outline-offset-2 outline-slate-300 outline-dashed',
        )}
      >
        {segments.map((p) => {
          const tiny = p.share > 0 && p.share < MIN_SHARE_FOR_NATURAL;
          const px = Math.max(p.share * width, tiny ? MIN_SEGMENT_PX : 0);
          const showLabel = width > 0 && px >= LABEL_MIN_PX;
          const internals = p.kind === 'harness-internals';
          const selected = selectedKind === p.kind;
          return (
            <Tooltip key={p.kind}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="anatomy-segment"
                  data-kind={p.kind}
                  aria-pressed={selected}
                  aria-label={`${p.label}: ${fmtShare(p.share)}`}
                  onClick={() => onSelect(p.kind)}
                  className={cn(
                    'h-full min-w-0 shrink overflow-hidden rounded-[2px] px-1.5 text-left text-[11px] leading-7 font-medium whitespace-nowrap focus-visible:outline-none',
                    internals ? 'text-slate-700' : 'text-white',
                    selected && 'ring-2 ring-primary ring-inset',
                  )}
                  style={{
                    flexBasis: `${p.share * 100}%`,
                    flexGrow: 0,
                    minWidth: tiny ? MIN_SEGMENT_PX : undefined,
                    background: internals ? HATCH : KIND_COLORS[p.kind],
                  }}
                >
                  {showLabel ? p.label : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <SegmentTooltip p={p} anatomy={anatomy} />
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
