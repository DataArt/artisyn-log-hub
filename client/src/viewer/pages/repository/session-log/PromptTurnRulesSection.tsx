import { useState } from 'react';
import { formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';
import { buildRulesSummary, SectionHeader } from './prompt-turn-helpers';
import type { RuleInjection } from './types';

interface Props {
  rulesInjected: RuleInjection[];
}

export function PromptTurnRulesSection({ rulesInjected }: Props) {
  const [rulesOpen, setRulesOpen] = useState(false);

  if (rulesInjected.length === 0) return null;

  return (
    <div className="ml-4 mt-2 border-l-2 border-l-teal-300 pl-2 dark:border-l-teal-700">
      <SectionHeader
        icon="§"
        label="Rules"
        summary={buildRulesSummary(rulesInjected)}
        open={rulesOpen}
        onToggle={() => setRulesOpen((v) => !v)}
      />
      {rulesOpen && (
        <div className="pl-2">
          <table className="mt-1 w-full">
            <tbody>
              {rulesInjected.map((rule) => {
                return (
                  <tr
                    key={rule.name}
                    className="transition-colors hover:bg-muted/30"
                  >
                    <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
                      <span className="inline-block shrink-0 rounded px-2 py-1 font-mono text-xs font-bold leading-none bg-teal-500/20 text-teal-700 dark:text-teal-300">
                        rule
                      </span>
                    </td>
                    <td className="w-px py-0.5 pr-4 align-middle whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                      {rule.estTokens !== undefined
                        ? `~${formatCompact(rule.estTokens)} tok`
                        : '—'}
                    </td>
                    <td className="py-0.5 align-middle font-mono text-sm text-foreground">
                      <span
                        title={rule.path ?? undefined}
                        className={cn(rule.path && 'cursor-help')}
                      >
                        {rule.name}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
