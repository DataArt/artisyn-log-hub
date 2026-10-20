import { Fragment } from 'react';
import { contextColorDynamic } from '@/lib/chart-colors';
import { formatBytes } from '../../log-parser';
import { CATEGORY_DESCRIPTIONS, type ContextSlice } from './context-data';

interface ContextUsageTableProps {
  slices: ContextSlice[];
}

export function ContextUsageTable({ slices }: ContextUsageTableProps) {
  if (slices.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
        No context data
      </div>
    );
  }

  const totalBytes = slices.reduce((sum, s) => sum + s.bytes, 0);
  const totalTokens = slices.reduce((sum, s) => sum + s.tokens, 0);

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-border text-muted-foreground">
          <th className="pb-1 text-left font-medium">Category</th>
          <th className="w-[90px] pb-1 text-right font-medium">Bytes</th>
          <th className="w-[90px] pb-1 text-right font-medium">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {slices.map((slice) => {
          const description = CATEGORY_DESCRIPTIONS[slice.key];
          return (
            <Fragment key={slice.key}>
              <tr className="border-b border-border/40">
                <td className="py-1 pr-2">
                  <span
                    className="flex items-center gap-1.5 cursor-help"
                    title={description}
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{
                        backgroundColor: contextColorDynamic(slice.key),
                      }}
                    />
                    {slice.label}
                    {description && (
                      <span className="text-muted-foreground/60 text-sm leading-none">
                        ⓘ
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums whitespace-nowrap">
                  {formatBytes(slice.bytes)}
                </td>
                <td className="py-1 text-right tabular-nums whitespace-nowrap">
                  {slice.tokens.toLocaleString()}
                </td>
              </tr>
              {slice.subRows?.map((sub, i) => (
                <tr
                  key={`${slice.key}-sub-${i}`}
                  className="border-b border-border/20"
                >
                  <td className="py-0.5 pl-5 pr-2 text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="shrink-0 inline-block w-3 h-px bg-border/60" />
                      <span className="truncate max-w-[160px]">
                        {sub.label}
                      </span>
                    </span>
                  </td>
                  <td className="py-0.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {formatBytes(sub.bytes)}
                  </td>
                  <td className="py-0.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {sub.tokens.toLocaleString()}
                  </td>
                </tr>
              ))}
            </Fragment>
          );
        })}
        <tr className="border-t border-border">
          <td className="py-1 font-bold">Total</td>
          <td className="py-1 text-right font-bold tabular-nums whitespace-nowrap">
            {formatBytes(totalBytes)}
          </td>
          <td className="py-1 text-right font-bold tabular-nums whitespace-nowrap">
            {totalTokens.toLocaleString()}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
