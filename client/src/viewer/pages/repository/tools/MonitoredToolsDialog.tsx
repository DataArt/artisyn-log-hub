/**
 * "Monitored tools" dialog of the Tools/MCP tab: the CLI tools whose calls the hook wraps, for
 * the caller's level (personal, or the team's in a team view). One row per tool — name, enabled
 * switch, capture (full / meta), level badges, the last wrapper record or a hint, remove — plus
 * "Add tool" and the "Pause all wrapping" switch. Names are checked as typed with
 * `validateToolName` from `@loghub/tool-monitor` (the same rules the server applies); a 400
 * from the save lands on the row it names. Read-only, with "Managed by team owner", when the
 * caller cannot edit the level.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  MAX_MONITORED_TOOLS,
  normalizeToolName,
  validateToolName,
} from '@loghub/tool-monitor';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import {
  saveToolMonitoringConfig,
  ToolMonitorConfigSaveError,
} from '../../../api';
import { formatLocalTimestamp } from '../../../lib/format';
import type {
  ToolMonitorCapture,
  ToolMonitorConfigToolView,
  ToolMonitorConfigView,
  ToolMonitorLevel,
} from '../../../../models/tool-monitoring';

export interface MonitoredToolsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoId: number;
  teamId?: number;
  config: ToolMonitorConfigView;
}

interface DraftRow {
  key: number;
  name: string;
  enabled: boolean;
  capture: ToolMonitorCapture;
  /** Server view of the row when it was loaded; null for a row added in this dialog. */
  saved: ToolMonitorConfigToolView | null;
}

const LEVEL_LABELS: Record<ToolMonitorLevel, string> = {
  personal: 'Personal',
  team: 'Team',
};

function hintText(
  row: ToolMonitorConfigToolView,
  config: ToolMonitorConfigView,
): string | null {
  switch (row.hint) {
    case 'preflight_failed': {
      const ws = config.wrapStatus;
      return `wrapper disabled on ${ws?.os ?? 'this OS'}: ${ws?.preflight.reason ?? 'pre-flight failed'}`;
    }
    case 'breaker':
      return 'breaker tripped';
    case 'hook_too_old':
      return 'hook too old';
    case 'no_data_yet':
      return 'no wrapper data yet';
    default:
      return null;
  }
}

/** The row's name problem: a `validateToolName` refusal, a duplicate, or null. */
function rowError(rows: DraftRow[], index: number): string | null {
  const name = rows[index].name;
  const v = validateToolName(name);
  if (!v.ok) return v.message;
  const key = normalizeToolName(name);
  const firstIndex = rows.findIndex((r) => normalizeToolName(r.name) === key);
  if (firstIndex !== index) return `\`${name}\` is already in the list`;
  return null;
}

function MonitoredToolsForm({
  repoId,
  teamId,
  config,
  onDone,
}: {
  repoId: number;
  teamId?: number;
  config: ToolMonitorConfigView;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const readOnly = !config.canEdit;
  const [nextKey, setNextKey] = useState(config.tools.length);
  const [paused, setPaused] = useState(config.paused);
  const [rows, setRows] = useState<DraftRow[]>(() =>
    config.tools.map((t, i) => ({
      key: i,
      name: t.name,
      enabled: t.enabled,
      capture: t.capture,
      saved: t,
    })),
  );
  // Name errors are shown once the user has touched the row or tried to save.
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{
    key: number | null;
    message: string;
  } | null>(null);

  const errors = useMemo(() => rows.map((_, i) => rowError(rows, i)), [rows]);
  const hasErrors = errors.some((e) => e !== null);

  const mutation = useMutation({
    mutationFn: () =>
      saveToolMonitoringConfig(
        repoId,
        {
          paused,
          tools: rows.map((r) => ({
            name: r.name,
            enabled: r.enabled,
            capture: r.capture,
          })),
        },
        teamId,
      ),
    onSuccess: (view) => {
      queryClient.setQueryData(
        ['tool-monitoring-config', repoId, teamId ?? null],
        view,
      );
      void queryClient.invalidateQueries({
        queryKey: ['tool-summary', repoId],
      });
      void queryClient.invalidateQueries({ queryKey: ['tool-calls', repoId] });
      onDone();
    },
    onError: (err) => {
      if (err instanceof ToolMonitorConfigSaveError) {
        const m = /^tools\[(\d+)\]/.exec(err.field ?? '');
        const row = m ? rows[Number(m[1])] : undefined;
        setServerError({
          key: row?.key ?? null,
          message:
            err.statusCode === 403
              ? 'No access — only the team owner can change this list.'
              : err.message || 'Error — the list could not be saved.',
        });
      } else {
        setServerError({
          key: null,
          message: 'Error — the list could not be saved.',
        });
      }
    },
  });

  const update = (key: number, patch: Partial<DraftRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
    if (serverError?.key === key) setServerError(null);
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { key: nextKey, name: '', enabled: true, capture: 'full', saved: null },
    ]);
    setNextKey((k) => k + 1);
  };

  const save = () => {
    setSubmitted(true);
    setServerError(null);
    if (hasErrors) return;
    mutation.mutate();
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <Switch
          id="tools-pause-all"
          checked={paused}
          onCheckedChange={setPaused}
          disabled={readOnly}
          data-testid="tools-pause-all"
        />
        <label htmlFor="tools-pause-all" className="text-sm">
          Pause all wrapping
        </label>
        <span className="text-xs text-muted-foreground">
          The hook wraps no tool while paused; the list is kept.
        </span>
      </div>

      {readOnly ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid="tools-config-readonly"
        >
          Managed by team owner.
        </div>
      ) : null}

      <div
        className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto"
        data-testid="tools-config-rows"
      >
        {rows.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            No monitored tools. MCP servers are recorded without any setup; add
            a CLI tool to record its calls too.
          </div>
        ) : null}
        {rows.map((row, i) => {
          const showError = submitted || touched.has(row.key);
          const error =
            (showError ? errors[i] : null) ??
            (serverError?.key === row.key ? serverError.message : null);
          const hint = row.saved ? hintText(row.saved, config) : null;
          return (
            <div
              key={row.key}
              className="flex flex-col gap-0.5 rounded-md border border-border px-2 py-1.5"
              data-testid="tools-config-row"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={row.name}
                  onChange={(e) => update(row.key, { name: e.target.value })}
                  onBlur={() =>
                    setTouched((prev) => new Set(prev).add(row.key))
                  }
                  placeholder="tool name, e.g. psql"
                  disabled={readOnly}
                  aria-invalid={error !== null}
                  aria-label="Tool name"
                  className="h-8 w-40 font-mono text-sm"
                  data-testid="tools-config-name"
                />
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(v) => update(row.key, { enabled: v })}
                  disabled={readOnly}
                  aria-label="Enabled"
                  data-testid="tools-config-enabled"
                />
                <select
                  value={row.capture}
                  onChange={(e) =>
                    update(row.key, {
                      capture: e.target.value === 'meta' ? 'meta' : 'full',
                    })
                  }
                  disabled={readOnly}
                  aria-label="Capture"
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  data-testid="tools-config-capture"
                >
                  <option value="full">full</option>
                  <option value="meta">meta only</option>
                </select>
                <span className="flex gap-1">
                  {(row.saved?.levels ?? []).map((l) => (
                    <span
                      key={l}
                      className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                    >
                      {LEVEL_LABELS[l]}
                    </span>
                  ))}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-right text-[11px]',
                    row.saved?.hint === 'preflight_failed' ||
                      row.saved?.hint === 'breaker'
                      ? 'text-amber-700'
                      : 'text-muted-foreground',
                  )}
                  title={hint ?? undefined}
                  data-testid="tools-config-status"
                >
                  {hint ??
                    (row.saved?.lastWrapperAt
                      ? `last received ${formatLocalTimestamp(row.saved.lastWrapperAt)}`
                      : '')}
                </span>
                {readOnly ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      setRows((prev) => prev.filter((r) => r.key !== row.key))
                    }
                    aria-label={`Remove ${row.name || 'tool'}`}
                    className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    data-testid="tools-config-remove"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              {error ? (
                <div
                  className="text-xs text-red-600"
                  data-testid="tools-config-error"
                >
                  {error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {serverError && serverError.key === null ? (
        <div
          className="text-xs text-red-600"
          data-testid="tools-config-save-error"
        >
          {serverError.message}
        </div>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        {readOnly ? (
          <span />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={rows.length >= MAX_MONITORED_TOOLS}
            data-testid="tools-config-add"
          >
            <Plus />
            Add tool
          </Button>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {readOnly ? null : (
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={mutation.isPending || (submitted && hasErrors)}
              data-testid="tools-config-save"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
      </DialogFooter>
    </>
  );
}

export function MonitoredToolsDialog({
  open,
  onOpenChange,
  repoId,
  teamId,
  config,
}: MonitoredToolsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="tools-monitored-dialog">
        <DialogHeader>
          <DialogTitle>Monitored tools</DialogTitle>
          <DialogDescription>
            {config.level === 'team'
              ? 'CLI tools the hook wraps for every member of this team in this repository.'
              : 'CLI tools the hook wraps in your sessions of this repository.'}{' '}
            Shells, the agent&apos;s own tools and shell builtins cannot be
            monitored.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <MonitoredToolsForm
            repoId={repoId}
            teamId={teamId}
            config={config}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
