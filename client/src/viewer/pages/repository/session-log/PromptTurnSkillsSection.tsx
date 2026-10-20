import { useState } from 'react';
import { formatCompact } from './log-parser';
import { DetailTooltip } from '../../../components/DetailTooltip';
import { DefinitionTooltip } from '../../../components/DefinitionTooltip';
import { cn } from '../../../lib/cn';
import {
  buildSkillsSummary,
  buildSkillDefinitionRows,
  shortenPath,
  SectionHeader,
} from './prompt-turn-helpers';
import type { SkillInvocation } from './types';

interface Props {
  skills: SkillInvocation[];
  charsPerToken?: number;
}

export function PromptTurnSkillsSection({ skills, charsPerToken }: Props) {
  const [skillsOpen, setSkillsOpen] = useState(false);

  if (skills.length === 0) return null;

  return (
    <div className="ml-4 mt-2 border-l-2 border-l-indigo-300 pl-2 dark:border-l-indigo-700">
      <SectionHeader
        icon="⚡"
        label="Skills"
        summary={buildSkillsSummary(skills)}
        open={skillsOpen}
        onToggle={() => setSkillsOpen((v) => !v)}
      />
      {skillsOpen && (
        <div className="pl-2">
          <table className="mt-1 w-full">
            <tbody>
              {skills.map((skill, i) => {
                const { display, full } = skill.path
                  ? shortenPath(skill.path)
                  : { display: skill.name, full: skill.name };
                return (
                  <tr key={i} className="transition-colors hover:bg-muted/30">
                    <td className="w-px py-0.5 pr-2 align-middle whitespace-nowrap">
                      <span className="inline-block shrink-0 rounded px-2 py-1 font-mono text-xs font-bold leading-none bg-indigo-500/20 text-indigo-700 dark:text-indigo-300">
                        skill
                      </span>
                    </td>
                    <td className="w-px py-0.5 pr-4 align-middle whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                      {skill.estTokens !== undefined
                        ? `~${formatCompact(skill.estTokens)} tok`
                        : '—'}
                    </td>
                    <td className="w-px py-0.5 pr-3 align-middle whitespace-nowrap">
                      {skill.isDuplicate && (
                        <DetailTooltip
                          rows={[
                            {
                              label: 'Duplicate',
                              value: 'Skill loaded twice in this turn.',
                            },
                          ]}
                        >
                          <span className="cursor-help font-mono text-[10px] text-muted-foreground/60">
                            dup
                          </span>
                        </DetailTooltip>
                      )}
                    </td>
                    <td className="py-0.5 align-middle font-mono text-sm text-foreground">
                      {skill.definition ? (
                        <DefinitionTooltip
                          rows={buildSkillDefinitionRows(
                            skill.definition,
                            charsPerToken,
                          )}
                        >
                          <span className="cursor-help">{display}</span>
                        </DefinitionTooltip>
                      ) : (
                        <span
                          title={full !== display ? full : undefined}
                          className={cn(full !== display && 'cursor-help')}
                        >
                          {display}
                        </span>
                      )}
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
