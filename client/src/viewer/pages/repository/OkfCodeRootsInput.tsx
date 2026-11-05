/**
 * Tag-list input of the OKF thresholds `codeRoots` field: one chip per repo-relative code
 * folder, a text box that adds a folder on Enter / comma / "Add", normalised to end in `/`.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { cn } from '../../lib/cn';
import { normaliseOkfCodeRoot, okfCodeRootsError } from './okf-thresholds-form';

export function OkfCodeRootsInput({
  roots,
  readOnly,
  onChange,
}: {
  roots: string[];
  readOnly: boolean;
  onChange: (roots: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const listError = okfCodeRootsError(roots);

  function add() {
    if (text.trim() === '') return;
    const result = normaliseOkfCodeRoot(text);
    if ('error' in result) {
      setEntryError(result.error);
      return;
    }
    if (!roots.includes(result.root)) onChange([...roots, result.root]);
    setText('');
    setEntryError(null);
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="okf-code-roots">
      <div className="flex flex-wrap gap-1">
        {roots.map((root) => (
          <span
            key={root}
            data-testid="okf-code-root"
            className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
          >
            {root}
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${root}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(roots.filter((r) => r !== root))}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {!readOnly && (
        <div className="flex items-center gap-1.5">
          <Input
            value={text}
            placeholder="e.g. src/"
            aria-label="Add a code folder"
            aria-invalid={entryError !== null}
            onChange={(e) => {
              setText(e.target.value);
              setEntryError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              }
            }}
            className={cn(
              'h-7 w-40 font-mono text-xs',
              entryError !== null && 'border-destructive',
            )}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7"
            disabled={text.trim() === ''}
            onClick={add}
          >
            Add
          </Button>
        </div>
      )}
      {entryError !== null && (
        <p className="text-xs text-destructive">Folder {entryError}.</p>
      )}
      {listError !== null && (
        <p className="text-xs text-destructive">codeRoots: {listError}.</p>
      )}
    </div>
  );
}
