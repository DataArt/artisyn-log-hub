/**
 * Cross-session overview for the selected date range.
 *
 * "Active" means *recency inside the selected range*, not a live-session concept: transcripts
 * are uploaded after the fact and the data carries no active/isActive notion. Ordered by last
 * activity descending, and every figure covers the session's whole sub-agent tree so a session
 * whose work was done by agents does not read as empty.
 *
 * When nothing matches, this renders an explicit zero-row state — a visible header plus a "No
 * sessions active in this range" row — rather than hiding, per the requirement.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import { formatCost, formatDuration, formatTokens } from '@/lib/format';
import { formatCount, NO_VALUE } from '@/lib/usage-analytics-format';
import { truncate } from '@/lib/format';
import type { ActiveSessionsResponse } from '../../../../models/repositories';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

const COLUMN_COUNT = 12;

export function ActiveSessionsView({
  data,
  onSessionClick,
}: {
  data: ActiveSessionsResponse;
  onSessionClick?: (sessionId: string) => void;
}) {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3" data-testid="active-sessions-view">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="text-right">Work time</TableHead>
                <TableHead className="text-right">Turns</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Tool calls</TableHead>
                <TableHead className="text-right">Lines +</TableHead>
                <TableHead className="text-right">Lines −</TableHead>
                <TableHead>Top tool</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sessions.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMN_COUNT}
                    className="h-24 text-center text-sm text-muted-foreground"
                    data-testid="active-sessions-empty"
                  >
                    No sessions active in this range.
                  </TableCell>
                </TableRow>
              ) : (
                data.sessions.map((row) => (
                  <TableRow
                    key={row.sessionId}
                    className={onSessionClick ? 'cursor-pointer' : undefined}
                    onClick={
                      onSessionClick
                        ? () => onSessionClick(row.sessionId)
                        : undefined
                    }
                  >
                    <TableCell className="max-w-[280px]">
                      {row.firstPrompt ? (
                        <Tooltip>
                          {/* `block truncate` is what actually keeps a long prompt
                              inside the column — without it the trigger overflows
                              and collides with the User cell. The JS truncate below
                              only caps how much text reaches the DOM. */}
                          <TooltipTrigger className="block max-w-full truncate text-left">
                            {truncate(row.firstPrompt, 60)}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[420px]">
                            {row.firstPrompt}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        // A null prompt in a team-scoped view is masking, not a
                        // missing value.
                        <span className="text-xs text-muted-foreground">
                          {PROMPT_HIDDEN_LABEL}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{row.userEmail}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.gitBranch ?? NO_VALUE}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {formatLastActivity(row.lastActivity)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDuration(row.workTimeMs)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(row.turns)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatTokens(row.totalTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.totalCost === null ? (
                        <Tooltip>
                          <TooltipTrigger className="underline decoration-dotted">
                            n/a
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[320px]">
                            No model in this session tree has a pricing row, so
                            no cost can be computed. Not the same as $0.00.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        formatCost(row.totalCost)
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(row.toolCalls)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(row.linesAdded)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCount(row.linesRemoved)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.topTool ?? NO_VALUE}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground">
          {data.truncated
            ? `Showing the ${data.limit} most recently active sessions; more matched the range.`
            : `${formatCount(data.sessions.length)} session(s) in the selected range.`}
          {
            ' Lines added/removed are diff-based and cover each session plus all of its'
          }
          {' descendant sub-agents.'}
        </p>
      </div>
    </TooltipProvider>
  );
}

/** `YYYY-MM-DD HH:mm` in the viewer's local zone — never a raw ISO string. */
function formatLastActivity(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return NO_VALUE;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
