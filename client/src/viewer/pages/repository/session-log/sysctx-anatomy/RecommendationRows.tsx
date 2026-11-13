// Table rows of the Recommendations modal: one row per matched catalog entry
// (`@loghub/recommendations`). Shows only catalog text, item names, counts and sizes.
import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type {
  DocLink,
  MatchedItem,
  RecommendationRow,
} from '@loghub/recommendations';
import { Button } from '@/ui/button';
import { useCopyToClipboard } from '../../../../hooks/useCopyToClipboard';
import { fmtInt } from './AnatomyCells';
import {
  CONTROLLER_LABELS,
  RECO_ITEMS_PREVIEW,
} from './sysctx-anatomy-constants';

/** Share in % with one decimal, rounded like the tab (`Math.round(share * 1000) / 10`). */
export function fmtRecoShare(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)} %`;
}

function ItemsLine({ items }: { items: MatchedItem[] }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = items.length - RECO_ITEMS_PREVIEW;
  const shown =
    showAll || hidden <= 0 ? items : items.slice(0, RECO_ITEMS_PREVIEW);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {shown.map((it, i) => (
        <span key={`${it.name}-${i}`} data-testid="sysctx-reco-item">
          <span className="font-mono">{it.name}</span>
          {it.status === 'failed' && (
            <span
              className="ml-1 rounded border border-amber-300 bg-amber-50 px-1 text-[10px] text-amber-800"
              data-testid="sysctx-reco-failed"
            >
              failed
            </span>
          )}
          {it.note && <span className="ml-1 italic">({it.note})</span>}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => setShowAll((v) => !v)}
          data-testid="sysctx-reco-more"
        >
          {showAll ? 'show less ▴' : `… ${fmtInt(hidden)} more ▾`}
        </button>
      )}
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  const { copied, copy } = useCopyToClipboard(text);
  return (
    <div className="mt-1 flex items-start gap-1">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy snippet'}
        title={copied ? 'Copied' : 'Copy snippet'}
        data-testid="sysctx-reco-copy"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Catalog links to the Claude Code docs; external, so they open in a new tab. */
function DocLinks({ docs }: { docs: DocLink[] }) {
  if (docs.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
      <span className="text-muted-foreground">Docs:</span>
      {docs.map((d) => (
        <a
          key={d.url}
          href={d.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-blue-600 underline-offset-2 hover:underline"
          data-testid="sysctx-reco-doc"
        >
          {d.label}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ))}
    </div>
  );
}

function TokensCell({ row }: { row: RecommendationRow }) {
  if (row.tokens === null || row.bytes === null) {
    return (
      <span className="text-muted-foreground" data-testid="sysctx-reco-tokens">
        not measured
      </span>
    );
  }
  return (
    <div data-testid="sysctx-reco-tokens">
      <div className="tabular-nums">≈ {fmtInt(row.tokens)}</div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {fmtRecoShare(row.share ?? 0)} · {fmtInt(row.bytes)} B
      </div>
    </div>
  );
}

const CELL = 'px-2 py-2 align-top';

export function RecommendationRows({ rows }: { rows: RecommendationRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.id}
          className="border-b last:border-b-0"
          data-testid="sysctx-reco-row"
          data-reco-id={row.id}
        >
          <td className={`${CELL} w-[22%]`}>
            <div className="font-medium">{row.title}</div>
            {row.note !== null && (
              <div
                className="text-xs text-muted-foreground"
                data-testid="sysctx-reco-note"
              >
                {row.note}
              </div>
            )}
            <ItemsLine items={row.items} />
          </td>
          <td className={`${CELL} w-[28%] text-muted-foreground`}>
            {row.explanation}
          </td>
          <td className={`${CELL} w-[10%] whitespace-nowrap`}>
            <TokensCell row={row} />
          </td>
          <td
            className={`${CELL} w-[12%]`}
            data-testid="sysctx-reco-controller"
          >
            {CONTROLLER_LABELS[row.controller]}
          </td>
          <td className={`${CELL} w-[28%]`}>
            <div>{row.disableText}</div>
            {row.snippet !== null && <Snippet text={row.snippet} />}
            <DocLinks docs={row.docs} />
          </td>
        </tr>
      ))}
    </>
  );
}
