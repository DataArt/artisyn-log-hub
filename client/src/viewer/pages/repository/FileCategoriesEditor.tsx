import { useRef, useState, useMemo, type ReactNode } from 'react';
import { Loader2, Trash2, GripVertical, Plus } from 'lucide-react';
import type { RepoConfig } from '../../../models/repositories';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../lib/cn';
import { resolveFileCategory } from './session-log/log-parser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  name: string;
  patterns: string;
}

interface RowValidation {
  nameError: string | null;
  patternsError: string | null;
  nameDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateName(name: string): string | null {
  if (!name.trim()) return 'Name is required';
  if (name.length > 64) return 'Name must be 64 characters or fewer';
  return null;
}

function validatePatterns(patterns: string): string | null {
  const parts = patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'At least one pattern is required';
  for (const p of parts) {
    try {
      new RegExp(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Invalid regular expression: ${msg}`;
    }
  }
  return null;
}

export function rowsToConfig(rows: CategoryRow[]): RepoConfig {
  return {
    fileCategories: rows.map((r) => ({
      name: r.name.trim(),
      patterns: r.patterns
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    })),
  };
}

export function configToRows(config: RepoConfig): CategoryRow[] {
  return config.fileCategories.map((cat, i) => ({
    id: `${i}-${cat.name}`,
    name: cat.name,
    patterns: cat.patterns.join(', '),
  }));
}

let rowCounter = 0;
export function newRowId() {
  rowCounter += 1;
  return `new-${rowCounter}`;
}

// ---------------------------------------------------------------------------
// CategoryRowEditor — single editable row
// ---------------------------------------------------------------------------

interface CategoryRowEditorProps {
  row: CategoryRow;
  validation: RowValidation;
  readOnly: boolean;
  onChangeName(name: string): void;
  onChangePatterns(patterns: string): void;
  onDelete(): void;
  onDragStart(e: React.DragEvent): void;
  onDragOver(e: React.DragEvent): void;
  onDrop(e: React.DragEvent): void;
}

function CategoryRowEditor({
  row,
  validation,
  readOnly,
  onChangeName,
  onChangePatterns,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: CategoryRowEditorProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-2">
        {!readOnly && (
          <span
            draggable
            onDragStart={onDragStart}
            className="flex shrink-0 cursor-grab items-center"
          >
            <GripVertical className="size-4 text-muted-foreground" />
          </span>
        )}
        <div className="flex flex-1 gap-2">
          <div className="w-36 shrink-0">
            <Input
              value={row.name}
              readOnly={readOnly}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="Category name"
              aria-invalid={!!validation.nameError}
              className={cn(
                'h-8 text-sm',
                validation.nameError && 'border-destructive',
                validation.nameDuplicate &&
                  !validation.nameError &&
                  'border-yellow-500',
              )}
            />
          </div>
          <div className="flex-1">
            <Input
              value={row.patterns}
              readOnly={readOnly}
              onChange={(e) => onChangePatterns(e.target.value)}
              placeholder="Comma-separated patterns"
              aria-invalid={!!validation.patternsError}
              className={cn(
                'h-8 text-sm font-mono',
                validation.patternsError && 'border-destructive',
              )}
            />
          </div>
          {!readOnly && (
            <button
              onClick={onDelete}
              className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-destructive"
              title="Delete category"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      {validation.nameError && (
        <p className="ml-6 text-xs text-destructive">{validation.nameError}</p>
      )}
      {!validation.nameError && validation.nameDuplicate && (
        <p className="ml-6 text-xs text-yellow-600 dark:text-yellow-400">
          Duplicate category name
        </p>
      )}
      {validation.patternsError && (
        <p className="ml-6 text-xs text-destructive">
          {validation.patternsError}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileTester — real-time path → category resolver
// ---------------------------------------------------------------------------

interface FileTesterProps {
  config: RepoConfig;
}

function FileTester({ config }: FileTesterProps) {
  const [testPath, setTestPath] = useState('');

  const resolved = useMemo(() => {
    if (!testPath.trim()) return null;
    try {
      return resolveFileCategory(testPath, '/', config);
    } catch {
      return 'code';
    }
  }, [testPath, config]);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-muted-foreground">
        Test a file path
      </label>
      <div className="flex items-center gap-2">
        <Input
          value={testPath}
          onChange={(e) => setTestPath(e.target.value)}
          placeholder="src/components/Foo.tsx"
          className="h-8 text-sm font-mono"
        />
        {resolved !== null && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
              resolved === 'code'
                ? 'bg-muted text-muted-foreground'
                : 'bg-primary/10 text-primary',
            )}
          >
            → {resolved === 'code' ? 'code (no match)' : resolved}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RegexpCheatSheet
// ---------------------------------------------------------------------------

const SYNTAX_REF = [
  {
    token: '.',
    meaning: 'Any single character',
    example: 'a.c matches "abc", "a1c", "a_c"',
  },
  {
    token: '.*',
    meaning: 'Zero or more of any character (greedy)',
    example: 'src/.* matches everything under src/',
  },
  {
    token: '.+',
    meaning: 'One or more of any character',
    example: '.+\\.ts requires at least one char before .ts',
  },
  {
    token: '\\.',
    meaning: 'Literal dot (escape with backslash)',
    example: '\\.ts$ matches ".ts", not "xts"',
  },
  {
    token: '^',
    meaning: 'Start of path — pins match to the beginning',
    example: '^src/ only matches paths that start with src/',
  },
  {
    token: '$',
    meaning: 'End of path — pins match to the end',
    example: '\\.ts$ only matches paths ending in .ts',
  },
  {
    token: '(a|b)',
    meaning: 'Either a or b',
    example: '\\.(ts|tsx)$ matches .ts or .tsx',
  },
];

const CHEAT_SHEET = [
  { pattern: 'docs/.*', description: 'All files anywhere under docs/' },
  {
    pattern: '^docs/.*',
    description: 'Files under docs/ at repo root (anchored)',
  },
  { pattern: '.*\\.md$', description: 'All Markdown files' },
  { pattern: '.*\\.(md|txt)$', description: 'Markdown or plain-text files' },
  {
    pattern: '^src/.*\\.ts$',
    description: 'TypeScript files under src/ (anchored)',
  },
  {
    pattern: 'name-prefix.*\\.ts$',
    description: 'TypeScript files whose name starts with a prefix',
  },
  {
    pattern: '.*\\.spec\\.(ts|tsx)$',
    description: 'Test spec files anywhere in the tree',
  },
  {
    pattern: '.*/(components|hooks)/.*',
    description: 'Files inside any components/ or hooks/ folder',
  },
];

function RegexpCheatSheet() {
  return (
    <div className="mt-1 space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        Regexp cheat sheet
      </p>

      <div className="overflow-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-1.5 text-left font-medium">Token</th>
              <th className="px-3 py-1.5 text-left font-medium">Meaning</th>
              <th className="px-3 py-1.5 text-left font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {SYNTAX_REF.map((row) => (
              <tr
                key={row.token}
                className="border-b border-border last:border-0"
              >
                <td className="px-3 py-1.5 font-mono text-foreground">
                  {row.token}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {row.meaning}
                </td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">
                  {row.example}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-1.5 text-left font-medium">Pattern</th>
              <th className="px-3 py-1.5 text-left font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {CHEAT_SHEET.map((row) => (
              <tr
                key={row.pattern}
                className="border-b border-border last:border-0"
              >
                <td className="px-3 py-1.5 font-mono">{row.pattern}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {row.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigEditor — editable category list for one tab
// ---------------------------------------------------------------------------

export interface ConfigEditorProps {
  rows: CategoryRow[];
  readOnly: boolean;
  hasChanges: boolean;
  isSaving: boolean;
  onRowsChange(rows: CategoryRow[]): void;
  onSave(): void;
  onReset(): void;
  currentConfig: RepoConfig;
  emptyState?: ReactNode;
  resetLabel: string;
  resetConfirmMessage: string;
}

export function ConfigEditor({
  rows,
  readOnly,
  hasChanges,
  isSaving,
  onRowsChange,
  onSave,
  onReset,
  currentConfig,
  emptyState,
  resetLabel,
  resetConfirmMessage,
}: ConfigEditorProps) {
  const dragSrcIdx = useRef<number | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const validations = useMemo<RowValidation[]>(() => {
    const names = rows.map((r) => r.name.trim().toLowerCase());
    return rows.map((row, i) => ({
      nameError: validateName(row.name),
      patternsError: validatePatterns(row.patterns),
      nameDuplicate:
        !validateName(row.name) &&
        names.filter((n) => n === row.name.trim().toLowerCase()).length > 1 &&
        names.indexOf(row.name.trim().toLowerCase()) !== i,
    }));
  }, [rows]);

  const hasErrors = validations.some(
    (v) => v.nameError !== null || v.patternsError !== null,
  );

  const canSave = hasChanges && !hasErrors && !isSaving;

  function handleAdd() {
    onRowsChange([...rows, { id: newRowId(), name: '', patterns: '' }]);
  }

  function handleDelete(idx: number) {
    onRowsChange(rows.filter((_, i) => i !== idx));
  }

  function handleChangeName(idx: number, name: string) {
    const next = rows.map((r, i) => (i === idx ? { ...r, name } : r));
    onRowsChange(next);
  }

  function handleChangePatterns(idx: number, patterns: string) {
    const next = rows.map((r, i) => (i === idx ? { ...r, patterns } : r));
    onRowsChange(next);
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
    onRowsChange(next);
  }

  return (
    <div className="flex flex-col gap-4">
      {emptyState}

      {rows.length === 0 && !emptyState && (
        <p className="text-sm text-muted-foreground">No custom categories.</p>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row, idx) => (
          <CategoryRowEditor
            key={row.id}
            row={row}
            validation={validations[idx]}
            readOnly={readOnly}
            onChangeName={(name) => handleChangeName(idx, name)}
            onChangePatterns={(patterns) => handleChangePatterns(idx, patterns)}
            onDelete={() => handleDelete(idx)}
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, idx)}
          />
        ))}

        {/* Implicit code row */}
        <div className="flex items-center gap-2 rounded border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          <span className="w-36 shrink-0 italic">code</span>
          <span className="flex-1 font-mono text-xs">
            Default (everything else)
          </span>
        </div>
      </div>

      {!readOnly && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            className="gap-1.5"
          >
            <Plus className="size-3.5" />
            Add category
          </Button>
        </div>
      )}

      <FileTester config={currentConfig} />

      <RegexpCheatSheet />

      {!readOnly && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {confirmingReset ? (
            <div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-3 py-2">
              <span className="flex-1 text-xs text-muted-foreground">
                {resetConfirmMessage}
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmingReset(false);
                  onReset();
                }}
              >
                Confirm
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {hasChanges && (
                <span className="text-xs text-muted-foreground">
                  Unsaved changes
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingReset(true)}
                >
                  {resetLabel}
                </Button>
                <Button size="sm" disabled={!canSave} onClick={onSave}>
                  {isSaving && <Loader2 className="size-3.5 animate-spin" />}
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
