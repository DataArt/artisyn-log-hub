import type * as React from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';

export function LogField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 text-xs py-0.5 min-w-0">
      <span className="text-muted-foreground shrink-0 w-36">{label}</span>
      <span className="font-mono break-all min-w-0">{children}</span>
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 mt-1 max-h-60 overflow-auto">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        handleCopy();
      }}
      className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
      title="Copy"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/** Collect unknown top-level keys not yet rendered and emit a JSON block. */
export function AdditionalFields({
  entry,
  knownKeys,
}: {
  entry: Record<string, unknown>;
  knownKeys: string[];
}) {
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(entry)) {
    if (!knownKeys.includes(k)) extra[k] = entry[k];
  }
  if (Object.keys(extra).length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground font-semibold mb-1">
        Additional fields
      </div>
      <JsonBlock value={extra} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Common fields rendered by most event types
// ---------------------------------------------------------------------------
export const COMMON_KEYS = [
  'type',
  'sessionId',
  'uuid',
  'parentUuid',
  'timestamp',
  'version',
  'entrypoint',
  'userType',
  'cwd',
  'gitBranch',
  'isSidechain',
  'slug',
  'requestId',
];

export function CommonFields({ entry }: { entry: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);

  const rows: { label: string; value: string }[] = [];
  if (entry.uuid !== undefined)
    rows.push({ label: 'UUID', value: String(entry.uuid) });
  if (entry.parentUuid !== undefined)
    rows.push({ label: 'Parent UUID', value: String(entry.parentUuid) });
  if (entry.sessionId !== undefined)
    rows.push({ label: 'Session ID', value: String(entry.sessionId) });
  if (entry.version !== undefined)
    rows.push({ label: 'Version', value: String(entry.version) });
  if (entry.entrypoint !== undefined)
    rows.push({ label: 'Entrypoint', value: String(entry.entrypoint) });
  if (entry.userType !== undefined)
    rows.push({ label: 'User type', value: String(entry.userType) });
  if (entry.cwd !== undefined)
    rows.push({ label: 'cwd', value: String(entry.cwd) });
  if (entry.gitBranch !== undefined)
    rows.push({ label: 'Git branch', value: String(entry.gitBranch) });
  if (entry.isSidechain !== undefined)
    rows.push({ label: 'Is sidechain', value: String(entry.isSidechain) });
  if (entry.slug !== undefined)
    rows.push({ label: 'Slug', value: String(entry.slug) });
  if (entry.requestId !== undefined)
    rows.push({ label: 'Request ID', value: String(entry.requestId) });

  if (rows.length === 0) return null;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        {open ? 'tech info' : 'tech info ···'}
      </button>
      {open && (
        <div className="mt-1 ml-4">
          {rows.map((r) => (
            <LogField key={r.label} label={r.label}>
              {r.value}
            </LogField>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollapsibleList({
  label,
  items,
}: {
  label: string;
  items: unknown[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2 text-xs py-0.5 min-w-0">
      <span className="text-muted-foreground shrink-0 w-36">{label}</span>
      <span className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          {items.length} item{items.length !== 1 ? 's' : ''}
        </button>
        {open && (
          <ul className="mt-1 space-y-0.5 ml-4">
            {items.map((it, i) => (
              <li key={i} className="font-mono break-all">
                {typeof it === 'string' ? it : JSON.stringify(it)}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}
