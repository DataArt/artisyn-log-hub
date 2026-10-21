import type { ClaudeMdFile } from './types';
import { formatBytes, formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';
import {
  getRuleShortName,
  instructionTypeMeta,
  shortenClaudeMdPath,
} from './context-panel-helpers';

interface TableProps {
  files: ClaudeMdFile[];
  charsPerToken: number;
  onSelect: (file: ClaudeMdFile) => void;
}

const thCls = 'pb-1 pr-3 text-left font-medium text-muted-foreground';
const numCls =
  'py-1 whitespace-nowrap text-right font-mono text-muted-foreground';

/** Files tab: CLAUDE.md / CLAUDE.local.md / ~/.claude/CLAUDE.md — metadata only, never text. */
export function InstructionFilesTable({
  files,
  charsPerToken,
  onSelect,
}: TableProps) {
  // User paths are already `~/…`; shorten only the repo paths against each other.
  const nonUserPaths = files
    .map((f) => f.path)
    .filter((p) => !p.startsWith('~/'));
  return (
    <table className="text-xs">
      <thead>
        <tr className="border-b border-border/50">
          <th className={thCls}>Path</th>
          <th className={thCls}>Type</th>
          <th className={cn(thCls, 'text-right')}>Size</th>
          <th className="pb-1 text-right font-medium text-muted-foreground">
            Tokens
          </th>
        </tr>
      </thead>
      <tbody>
        {files.map((file, i) => {
          const displayPath = file.path.startsWith('~/')
            ? file.path
            : shortenClaudeMdPath(file.path, nonUserPaths);
          const meta = instructionTypeMeta(file);
          const estTok = Math.round(file.bytes / charsPerToken);
          return (
            <tr
              key={i}
              data-testid="sysctx-file-row"
              data-file-type={meta.label}
              className="cursor-pointer hover:bg-muted/30"
              onClick={() => onSelect(file)}
            >
              <td className="py-1 pr-3 font-mono text-foreground/80">
                {displayPath}
              </td>
              <td className="py-1 pr-3">
                <span className={cn('text-xs', meta.cls)}>{meta.label}</span>
              </td>
              <td className={cn(numCls, 'pr-3')}>{formatBytes(file.bytes)}</td>
              <td className={numCls}>~{formatCompact(estTok)} tok</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Rules tab: `.claude/rules/*.md` — name, size, tokens. */
export function RulesTable({ files, charsPerToken, onSelect }: TableProps) {
  return (
    <table className="text-xs">
      <thead>
        <tr className="border-b border-border/50">
          <th className={thCls}>Name</th>
          <th className={cn(thCls, 'text-right')}>Size</th>
          <th className="pb-1 text-right font-medium text-muted-foreground">
            Tokens
          </th>
        </tr>
      </thead>
      <tbody>
        {files.map((file, i) => {
          const estTok = Math.round(file.bytes / charsPerToken);
          return (
            <tr
              key={i}
              data-testid="sysctx-rule-row"
              data-file-type={instructionTypeMeta(file).label}
              className="cursor-pointer hover:bg-muted/30"
              onClick={() => onSelect(file)}
            >
              <td className="py-1 pr-3 font-mono text-foreground/80">
                {getRuleShortName(file.path)}
              </td>
              <td className={cn(numCls, 'pr-3')}>{formatBytes(file.bytes)}</td>
              <td className={numCls}>~{formatCompact(estTok)} tok</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
