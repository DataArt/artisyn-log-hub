/**
 * A collapsible JSON tree for the Tools/MCP details pane: objects and arrays expand and
 * collapse, the first two levels start open, scalars are coloured by type. Monospace on the
 * light surface only.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** Levels open on first render: the root (0) and its children (1). */
const OPEN_DEPTH = 2;

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="text-gray-500">null</span>;
  if (typeof value === 'string') {
    return (
      <span className="break-all whitespace-pre-wrap text-green-700">
        {JSON.stringify(value)}
      </span>
    );
  }
  if (typeof value === 'number') {
    return <span className="text-blue-700">{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-fuchsia-700">{String(value)}</span>;
  }
  return <span className="text-gray-500">{String(value)}</span>;
}

function Key({ name }: { name: string | number | null }) {
  if (name === null) return null;
  return (
    <>
      <span
        className={typeof name === 'number' ? 'text-gray-400' : 'text-sky-800'}
      >
        {typeof name === 'number' ? name : JSON.stringify(name)}
      </span>
      <span className="text-gray-400">: </span>
    </>
  );
}

function Node({
  name,
  value,
  depth,
}: {
  name: string | number | null;
  value: unknown;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';

  if (!isObject) {
    return (
      <div className="pl-4">
        <Key name={name} />
        <Scalar value={value} />
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];
  const summary = isArray
    ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `${entries.length} key${entries.length === 1 ? '' : 's'}`;

  if (entries.length === 0) {
    return (
      <div className="pl-4">
        <Key name={name} />
        <span className="text-gray-500">
          {openBrace}
          {closeBrace}
        </span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-start text-left hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3 shrink-0 text-gray-400" />
        ) : (
          <ChevronRight className="mt-0.5 size-3 shrink-0 text-gray-400" />
        )}
        <span className="pl-1">
          <Key name={name} />
          <span className="text-gray-500">{openBrace}</span>
          {open ? null : (
            <span className="text-gray-400">
              {' '}
              {summary} {closeBrace}
            </span>
          )}
        </span>
      </button>
      {open ? (
        <>
          <div className="ml-1.5 border-l border-border pl-1">
            {entries.map(([k, v]) => (
              <Node key={String(k)} name={k} value={v} depth={depth + 1} />
            ))}
          </div>
          <div className="pl-4 text-gray-500">{closeBrace}</div>
        </>
      ) : null}
    </div>
  );
}

/** The tree of `value` (already parsed JSON). */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div
      className="font-mono text-xs leading-5 text-foreground"
      data-testid="tools-json-tree"
    >
      <Node name={null} value={value} depth={0} />
    </div>
  );
}
