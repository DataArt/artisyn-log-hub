import { useRef, useState, useMemo } from 'react';
import { Loader2, Trash2, GripVertical, Plus } from 'lucide-react';
import type { SessionAttributionAttributeDef } from '../../../models/repositories';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../lib/cn';
import {
  SESSION_ATTRIBUTION_MAX_ATTRIBUTES,
  SESSION_ATTRIBUTION_TYPES,
  SESSION_ATTRIBUTION_TYPE_LABELS,
  validateAttributeKey,
  validateAttributeLabel,
  validateAttributePrompt,
} from '../../lib/session-attribution-ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttributeRow {
  id: string;
  key: string;
  label: string;
  type: SessionAttributionAttributeDef['type'];
  prompt: string;
}

interface RowValidation {
  keyError: string | null;
  keyDuplicate: boolean;
  labelError: string | null;
  promptError: string | null;
}

export interface SessionAttributionValue {
  enabled: boolean;
  attributes: SessionAttributionAttributeDef[];
}

// ---------------------------------------------------------------------------
// Row <-> config conversion helpers
// ---------------------------------------------------------------------------

let rowCounter = 0;
export function newAttributeRowId() {
  rowCounter += 1;
  return `new-${rowCounter}`;
}

export function attributesToRows(
  attributes: SessionAttributionAttributeDef[],
): AttributeRow[] {
  return attributes.map((a, i) => ({
    id: `${i}-${a.key}`,
    key: a.key,
    label: a.label,
    type: a.type,
    prompt: a.prompt,
  }));
}

export function rowsToAttributes(
  rows: AttributeRow[],
): SessionAttributionAttributeDef[] {
  return rows.map((r) => ({
    key: r.key.trim(),
    label: r.label.trim(),
    type: r.type,
    prompt: r.prompt.trim(),
  }));
}

// ---------------------------------------------------------------------------
// AttributeRowEditor — single editable row
// ---------------------------------------------------------------------------

interface AttributeRowEditorProps {
  row: AttributeRow;
  validation: RowValidation;
  readOnly: boolean;
  /** Once a key has been saved, its `key`/`type` binding is immutable server-side
   * — locked here to avoid a save-time 400. */
  keyLocked: boolean;
  onChangeKey(key: string): void;
  onChangeLabel(label: string): void;
  onChangeType(type: SessionAttributionAttributeDef['type']): void;
  onChangePrompt(prompt: string): void;
  onDelete(): void;
  onDragStart(e: React.DragEvent): void;
  onDragOver(e: React.DragEvent): void;
  onDrop(e: React.DragEvent): void;
}

function AttributeRowEditor({
  row,
  validation,
  readOnly,
  keyLocked,
  onChangeKey,
  onChangeLabel,
  onChangeType,
  onChangePrompt,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: AttributeRowEditorProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="flex flex-col gap-1 rounded border border-border p-2"
    >
      <div className="flex items-start gap-2">
        {!readOnly && (
          <span
            draggable
            onDragStart={onDragStart}
            className="mt-1.5 flex shrink-0 cursor-grab items-center"
          >
            <GripVertical className="size-4 text-muted-foreground" />
          </span>
        )}
        <div className="flex flex-1 flex-wrap gap-2">
          <div className="w-40 shrink-0">
            <Input
              value={row.key}
              readOnly={readOnly || keyLocked}
              onChange={(e) => onChangeKey(e.target.value)}
              placeholder="key"
              title={
                keyLocked
                  ? 'Key is locked once saved — historical values are typed by it'
                  : undefined
              }
              aria-invalid={!!validation.keyError}
              className={cn(
                'h-8 font-mono text-sm',
                validation.keyError && 'border-destructive',
                validation.keyDuplicate &&
                  !validation.keyError &&
                  'border-yellow-500',
                keyLocked && 'text-muted-foreground',
              )}
            />
          </div>
          <div className="w-40 shrink-0">
            <Input
              value={row.label}
              readOnly={readOnly}
              onChange={(e) => onChangeLabel(e.target.value)}
              placeholder="Label"
              aria-invalid={!!validation.labelError}
              className={cn(
                'h-8 text-sm',
                validation.labelError && 'border-destructive',
              )}
            />
          </div>
          <div className="w-32 shrink-0">
            <select
              value={row.type}
              disabled={readOnly || keyLocked}
              title={
                keyLocked
                  ? 'Type is locked once saved — historical values are typed by it'
                  : undefined
              }
              onChange={(e) =>
                onChangeType(
                  e.target.value as SessionAttributionAttributeDef['type'],
                )
              }
              className={cn(
                'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none',
                'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                keyLocked && 'text-muted-foreground',
              )}
            >
              {SESSION_ATTRIBUTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SESSION_ATTRIBUTION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-64 flex-1">
            <textarea
              value={row.prompt}
              readOnly={readOnly}
              onChange={(e) => onChangePrompt(e.target.value)}
              placeholder="Describe what the model should determine, e.g. the ticket key the session works on"
              rows={2}
              aria-invalid={!!validation.promptError}
              className={cn(
                'w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none',
                'placeholder:text-muted-foreground',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                validation.promptError && 'border-destructive',
              )}
            />
          </div>
          {!readOnly && (
            <button
              onClick={onDelete}
              className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-destructive"
              title="Delete attribute"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      {(validation.keyError ||
        (validation.keyDuplicate && !validation.keyError) ||
        validation.labelError ||
        validation.promptError) && (
        <div className="ml-6 flex flex-col gap-0.5">
          {validation.keyError && (
            <p className="text-xs text-destructive">{validation.keyError}</p>
          )}
          {!validation.keyError && validation.keyDuplicate && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              Duplicate attribute key
            </p>
          )}
          {validation.labelError && (
            <p className="text-xs text-destructive">{validation.labelError}</p>
          )}
          {validation.promptError && (
            <p className="text-xs text-destructive">{validation.promptError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionAttributionSettings — Settings tab body
// ---------------------------------------------------------------------------

export interface SessionAttributionSettingsProps {
  /** Resolved starting value for the form — the team's saved override, or (when the team
   * has none) the built-in default attributes, `enabled: true`. */
  initialValue: SessionAttributionValue;
  /** Attribute keys that are actually persisted (not the built-in "starting point" default) —
   * used to lock `key`/`type` on rows the server would reject a rebind on. Empty when the
   * team has no saved override yet, since nothing is committed to be immutable. */
  savedKeys: readonly string[];
  /** `true` when this repo belongs to no team at all — the feature has nothing to attach to,
   * distinct from `readOnly` (team exists, caller isn't its owner). */
  noTeam: boolean;
  readOnly: boolean;
  isSaving: boolean;
  onSave(value: SessionAttributionValue): void;
}

export function SessionAttributionSettings({
  initialValue,
  savedKeys,
  noTeam,
  readOnly,
  isSaving,
  onSave,
}: SessionAttributionSettingsProps) {
  const [enabled, setEnabled] = useState(initialValue.enabled);
  const [rows, setRows] = useState<AttributeRow[]>(() =>
    attributesToRows(initialValue.attributes),
  );
  const dragSrcIdx = useRef<number | null>(null);

  const savedKeySet = useMemo(() => new Set(savedKeys), [savedKeys]);

  const validations = useMemo<RowValidation[]>(() => {
    const keys = rows.map((r) => r.key.trim().toLowerCase());
    return rows.map((row, i) => ({
      keyError: validateAttributeKey(row.key),
      keyDuplicate:
        !validateAttributeKey(row.key) &&
        keys.filter((k) => k === row.key.trim().toLowerCase()).length > 1 &&
        keys.indexOf(row.key.trim().toLowerCase()) !== i,
      labelError: validateAttributeLabel(row.label),
      promptError: validateAttributePrompt(row.prompt),
    }));
  }, [rows]);

  const hasErrors = validations.some(
    (v) =>
      v.keyError !== null || v.labelError !== null || v.promptError !== null,
  );

  const hasChanges =
    enabled !== initialValue.enabled ||
    JSON.stringify(rowsToAttributes(rows)) !==
      JSON.stringify(initialValue.attributes);

  const canSave = !readOnly && hasChanges && !hasErrors && !isSaving;
  const atMax = rows.length >= SESSION_ATTRIBUTION_MAX_ATTRIBUTES;

  function handleAdd() {
    setRows([
      ...rows,
      {
        id: newAttributeRowId(),
        key: '',
        label: '',
        type: 'string',
        prompt: '',
      },
    ]);
  }

  function handleDelete(idx: number) {
    setRows(rows.filter((_, i) => i !== idx));
  }

  function handleChange(idx: number, patch: Partial<AttributeRow>) {
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function handleDragStart(e: React.DragEvent, idx: number) {
    e.dataTransfer.effectAllowed = 'move';
    dragSrcIdx.current = idx;
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(_e: React.DragEvent, dropIdx: number) {
    const src = dragSrcIdx.current;
    if (src === null || src === dropIdx) return;
    const next = [...rows];
    const [item] = next.splice(src, 1);
    next.splice(dropIdx, 0, item);
    dragSrcIdx.current = null;
    setRows(next);
  }

  if (noTeam) {
    return (
      <p className="text-xs font-medium text-muted-foreground">
        Session attributes are a team-level setting — this repository does not
        belong to a team you can configure it for.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <p className="text-xs font-medium text-muted-foreground">
          Managed by team owner
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="flex cursor-pointer select-none items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={readOnly}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-primary disabled:cursor-not-allowed"
          />
          <span className="text-sm font-medium">AI Attribute Extraction</span>
        </label>
        <p className="ml-5 text-xs text-muted-foreground">
          After a session ends, an LLM reads its transcript and extracts the
          attributes defined below (Jira ticket, workflow stage, etc.). These
          attributes can then be used to filter and group sessions.
        </p>
        <p className="ml-5 text-xs text-yellow-700 dark:text-yellow-400">
          Each evaluation is a small extra LLM call and typically costs roughly
          1–5¢, independent of the session it evaluates.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, idx) => (
          <AttributeRowEditor
            key={row.id}
            row={row}
            validation={validations[idx]}
            readOnly={readOnly}
            keyLocked={savedKeySet.has(row.key)}
            onChangeKey={(key) => handleChange(idx, { key })}
            onChangeLabel={(label) => handleChange(idx, { label })}
            onChangeType={(type) => handleChange(idx, { type })}
            onChangePrompt={(prompt) => handleChange(idx, { prompt })}
            onDelete={() => handleDelete(idx)}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, idx)}
          />
        ))}

        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No attributes declared — attribute extraction has nothing to fill
            in.
          </p>
        )}
      </div>

      {!readOnly && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={atMax}
            className="gap-1.5"
            title={
              atMax
                ? `Maximum ${SESSION_ATTRIBUTION_MAX_ATTRIBUTES} attributes allowed`
                : undefined
            }
          >
            <Plus className="size-3.5" />
            Add attribute
          </Button>
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2 border-t border-border pt-3">
          {hasChanges && (
            <span className="text-xs text-muted-foreground">
              Unsaved changes
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() =>
                onSave({ enabled, attributes: rowsToAttributes(rows) })
              }
            >
              {isSaving && <Loader2 className="size-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
