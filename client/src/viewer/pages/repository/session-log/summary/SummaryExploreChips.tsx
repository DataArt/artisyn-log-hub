/**
 * Summary hub, "Explore" row (FR-D5): four question chips, each switching to its lens — the
 * lens switch opens that lens's default tab (DD-7, DD-20).
 */
import { Button } from '@/ui/button';
import type { LensId } from '../../session-lenses';
import { EXPLORE_CHIPS } from './summary-cards';

interface Props {
  onLensSwitch: (lens: LensId) => void;
}

export function SummaryExploreChips({ onLensSwitch }: Props) {
  return (
    <section className="flex max-w-5xl flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">Explore</span>
      {EXPLORE_CHIPS.map((chip) => (
        <Button
          key={chip.lens}
          variant="outline"
          size="xs"
          className="rounded-full"
          data-testid={`summary-explore-${chip.lens}`}
          onClick={() => onLensSwitch(chip.lens)}
        >
          {chip.label}
        </Button>
      ))}
    </section>
  );
}
