import type { PromptTurn } from './types';
import type { ModelPricingMap } from '../../../../models/pricing';
import {
  computeCost,
  formatCost,
  formatDuration,
  formatTokens,
} from '../../../lib/format';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../ui/tooltip';
import { NoPricingBadge } from '../../../components/NoPricingBadge';

export function TurnHeader({
  displayIndex,
  turn,
  pricing,
  sessionModel,
}: {
  displayIndex: number;
  turn: PromptTurn;
  pricing?: ModelPricingMap;
  sessionModel?: string;
}) {
  const pricingEntry =
    pricing && sessionModel ? pricing[sessionModel] : undefined;
  const cost =
    pricingEntry && turn.tokenBreakdown
      ? computeCost(turn.tokenBreakdown, pricingEntry)
      : null;
  // The rates are loaded (`pricing` present) but this session's model has no row,
  // so the turn's cost is unknown, not zero. Before, the slot was simply left empty.
  const unpricedModel =
    pricing && sessionModel && !pricingEntry && turn.tokenBreakdown
      ? sessionModel
      : null;

  const tb = turn.tokenBreakdown;

  const rawPrompt = (() => {
    const content = turn.userEvent?.message?.content;
    if (!content) return '';
    if (typeof content === 'string') return content;
    const block = content.find((b) => b.type === 'text' && b.text);
    return block?.text ?? '';
  })();
  const prompt = rawPrompt.trim().replace(/\s+/g, ' ');

  return (
    <tr>
      <td
        colSpan={3}
        className="py-2 px-4 bg-sky-50 dark:bg-sky-950/40 border-t-2 border-sky-200 dark:border-sky-800"
      >
        <TooltipProvider>
          <div className="flex items-center gap-4 text-sm text-sky-800 dark:text-sky-300 min-w-0 overflow-hidden">
            <span className="font-bold shrink-0 text-sky-900 dark:text-sky-200">
              Turn #{displayIndex}
            </span>
            {turn.workTimeMs != null && (
              <span className="shrink-0 text-sky-700 dark:text-sky-400 font-medium">
                {formatDuration(turn.workTimeMs)}
              </span>
            )}
            {tb && (
              <span className="shrink-0 font-mono text-sky-700 dark:text-sky-400 flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">
                      {formatTokens(tb.input)}↑
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Input tokens</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">
                      {formatTokens(tb.output)}↓
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Output tokens</TooltipContent>
                </Tooltip>
                <span className="text-sky-400 dark:text-sky-600 select-none">
                  |
                </span>
                <span className="text-sky-600 dark:text-sky-500">Cache</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">
                      <span className="text-sky-600 dark:text-sky-500">
                        read:
                      </span>{' '}
                      {formatTokens(tb.cacheRead)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Cache read tokens</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default">
                      <span className="text-sky-600 dark:text-sky-500">
                        write:
                      </span>{' '}
                      {formatTokens(tb.cacheWrite)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Cache write tokens</TooltipContent>
                </Tooltip>
              </span>
            )}
            {cost != null && (
              <span className="shrink-0 font-mono font-semibold text-sky-800 dark:text-sky-300">
                {formatCost(cost)}
              </span>
            )}
            {unpricedModel != null && (
              <span className="shrink-0">
                <NoPricingBadge modelId={unpricedModel} />
              </span>
            )}
            {prompt && (
              <span className="truncate text-sky-600 dark:text-sky-500 italic min-w-0">
                {prompt}
              </span>
            )}
          </div>
        </TooltipProvider>
      </td>
    </tr>
  );
}
