/**
 * Summary hub, "Where to look next" (FR-D1–D4): one card per target tab, built by the pure
 * `buildSummaryCards` from data the pane already holds. Card chrome follows `SummaryStatTile`
 * (`rounded-md border px-4 py-3`, muted label, mono value); a dimmed card is `opacity-60` and
 * reads "No data in this session". "Open →" switches the session tab.
 */
import { Button } from '@/ui/button';
import { cn } from '@/lib/cn';
import type { SessionTab } from '../../useRepositoryViewState';
import type { SummaryCard } from './summary-cards';

interface Props {
  cards: SummaryCard[];
  onSessionTabChange: (tab: SessionTab) => void;
}

export function SummaryNextCards({ cards, onSessionTabChange }: Props) {
  return (
    <section className="flex max-w-5xl flex-col gap-2">
      <h3 className="text-sm font-semibold">Where to look next</h3>
      <div
        data-testid="summary-next-cards"
        className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3"
      >
        {cards.map((c) => (
          <div
            key={c.tab}
            data-testid={`summary-card-${c.tab}`}
            data-dimmed={c.dimmed ? 'true' : undefined}
            className={cn(
              'flex flex-col rounded-md border px-4 py-3',
              c.dimmed && 'opacity-60',
            )}
          >
            <div className="text-xs font-medium">{c.title}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {c.description}
            </div>
            {c.headline != null && (
              <div
                data-testid={`summary-card-${c.tab}-headline`}
                className="mt-2 font-mono text-lg font-bold"
              >
                {c.headline}
              </div>
            )}
            {c.subline != null && (
              <div className="mt-1 text-xs text-muted-foreground">
                {c.subline}
              </div>
            )}
            <div className="mt-auto pt-2">
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0"
                data-testid={`summary-card-${c.tab}-open`}
                onClick={() => onSessionTabChange(c.tab)}
              >
                Open →
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
