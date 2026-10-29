// Drill-down tables of the "System context anatomy" partition table (impl-plan DD 8–11).
// Rows carry only names, paths, sizes, statuses and role labels — never file or prompt text.
import { useState } from 'react';
import type { AnatomyPartition, AnatomyRow } from './sysctx-anatomy';
import {
  DrillTable,
  fmtBytesOrDash,
  fmtInt,
  fmtShare,
  GitBadge,
  NumCell,
  ShowAllToggle,
  sourceLabel,
  TextCell,
} from './AnatomyCells';
import { MCP_PREVIEW, SKILLS_PREVIEW } from './sysctx-anatomy-constants';

const ROW_CLASS = 'border-b border-border/60 last:border-0';

function SizeCells({ row }: { row: AnatomyRow }) {
  return (
    <>
      <NumCell>{fmtInt(row.bytes)}</NumCell>
      <NumCell>{fmtInt(row.tokens)}</NumCell>
      <NumCell>{fmtShare(row.share)}</NumCell>
    </>
  );
}

/** Skills listing: one row per listed skill, sorted by bytes, first SKILLS_PREVIEW shown (DD 9). */
export function SkillsDrilldown({ rows }: { rows: AnatomyRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, SKILLS_PREVIEW);
  return (
    <div>
      <DrillTable
        columns={[
          'Skill',
          'Source',
          'File',
          '#File size',
          'Git',
          '#Listing B',
          '#≈ Tokens',
          '#Share',
        ]}
      >
        {visible.map((r) => (
          <tr
            key={r.key}
            className={ROW_CLASS}
            data-testid="anatomy-skill-row"
            data-skill-name={r.label}
            data-source={r.source ?? ''}
          >
            <TextCell className="font-mono">{r.label}</TextCell>
            <TextCell>{sourceLabel(r.source)}</TextCell>
            <TextCell className="font-mono break-all text-muted-foreground">
              {r.path ?? '—'}
            </TextCell>
            <NumCell>{fmtBytesOrDash(r.fileBytes)}</NumCell>
            <TextCell>
              <GitBadge git={r.path ? (r.git ?? 'unknown') : null} />
            </TextCell>
            <SizeCells row={r} />
          </tr>
        ))}
      </DrillTable>
      {rows.length > SKILLS_PREVIEW && (
        <ShowAllToggle
          total={rows.length}
          noun="skills"
          expanded={showAll}
          onToggle={() => setShowAll((v) => !v)}
        />
      )}
    </div>
  );
}

function FileRow({ r }: { r: AnatomyRow }) {
  const path = r.path ?? r.label;
  return (
    <tr
      className={ROW_CLASS}
      data-testid="anatomy-file-row"
      data-path={path}
      data-git={r.git ?? 'unknown'}
    >
      <TextCell className="font-mono break-all">{path}</TextCell>
      <TextCell>{r.fileKind ?? '—'}</TextCell>
      <TextCell>
        <GitBadge git={r.git ?? 'unknown'} />
      </TextCell>
      <NumCell>{fmtBytesOrDash(r.fileBytes)}</NumCell>
      <SizeCells row={r} />
    </tr>
  );
}

/** Instruction files: loaded at start, then an "On demand — 0 at start" subgroup (DD 10). */
export function FilesDrilldown({ rows }: { rows: AnatomyRow[] }) {
  const loaded = rows.filter((r) => !r.onDemand);
  const onDemand = rows.filter((r) => r.onDemand);
  return (
    <DrillTable
      columns={[
        'Path',
        'Kind',
        'Git',
        '#File size',
        '#Loaded B',
        '#≈ Tokens',
        '#Share',
      ]}
    >
      {loaded.map((r) => (
        <FileRow key={r.key} r={r} />
      ))}
      {onDemand.length > 0 && (
        <>
          <tr className="border-b border-border/60">
            <td
              colSpan={7}
              className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              On demand — 0 at start
            </td>
          </tr>
          {onDemand.map((r) => (
            <FileRow key={r.key} r={r} />
          ))}
        </>
      )}
    </DrillTable>
  );
}

function McpRow({ r }: { r: AnatomyRow }) {
  const [open, setOpen] = useState(false);
  const names = r.onDemandNames ?? [];
  return (
    <>
      <tr
        className={ROW_CLASS}
        data-testid="anatomy-mcp-row"
        data-server={r.label}
      >
        <TextCell className="font-mono">{r.label}</TextCell>
        <TextCell
          className={r.status === 'failed' ? 'text-red-700' : undefined}
        >
          {r.status === 'failed'
            ? `failed (${r.errorCode ?? 'unknown'})`
            : 'connected'}
        </TextCell>
        <NumCell>{fmtInt(r.tools ?? 0)}</NumCell>
        <NumCell>{fmtInt(r.namesBytes ?? 0)}</NumCell>
        <NumCell>{fmtInt(r.instrBytes ?? 0)}</NumCell>
        <NumCell>
          {names.length === 0 ? (
            '0'
          ) : (
            <button
              type="button"
              className="text-primary hover:underline"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {names.length} {open ? '▴' : '▾'}
            </button>
          )}
        </NumCell>
        <SizeCells row={r} />
      </tr>
      {open && names.length > 0 && (
        <tr className={ROW_CLASS}>
          <td colSpan={9} className="px-2 py-1 pl-6">
            <div className="text-[11px] text-muted-foreground">
              Loaded on demand (not part of the startup size):
            </div>
            <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
              {names.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/** MCP servers: names + instructions bytes per server, first MCP_PREVIEW shown (DD 8). */
export function McpDrilldown({ rows }: { rows: AnatomyRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, MCP_PREVIEW);
  return (
    <div>
      <DrillTable
        columns={[
          'Server',
          'Status',
          '#Tools',
          '#Names B',
          '#Instr. B',
          '#Loaded on demand',
          '#Bytes',
          '#≈ Tokens',
          '#Share',
        ]}
      >
        {visible.map((r) => (
          <McpRow key={r.key} r={r} />
        ))}
      </DrillTable>
      {rows.length > MCP_PREVIEW && (
        <ShowAllToggle
          total={rows.length}
          noun="servers"
          expanded={showAll}
          onToggle={() => setShowAll((v) => !v)}
        />
      )}
    </div>
  );
}

/** Any other kind: name (or "Block n" / role label), source, optional file + git, sizes. */
export function GenericRows({ rows }: { rows: AnatomyRow[] }) {
  const withFile = rows.some((r) => r.path !== undefined);
  const columns = withFile
    ? [
        'Name',
        'Source',
        'File',
        '#File size',
        'Git',
        '#Bytes',
        '#≈ Tokens',
        '#Share',
      ]
    : ['Name', 'Source', '#Bytes', '#≈ Tokens', '#Share'];
  return (
    <DrillTable columns={columns}>
      {rows.map((r) => (
        <tr key={r.key} className={ROW_CLASS} data-row-kind={r.kind}>
          <TextCell className="font-mono">{r.label}</TextCell>
          <TextCell>{sourceLabel(r.source)}</TextCell>
          {withFile && (
            <>
              <TextCell className="font-mono break-all text-muted-foreground">
                {r.path ?? '—'}
              </TextCell>
              <NumCell>{fmtBytesOrDash(r.fileBytes)}</NumCell>
              <TextCell>
                <GitBadge git={r.path ? (r.git ?? 'unknown') : null} />
              </TextCell>
            </>
          )}
          <SizeCells row={r} />
        </tr>
      ))}
    </DrillTable>
  );
}

/** Picks the drill-down of a partition's kind. */
export function PartitionDrilldown({
  partition,
}: {
  partition: AnatomyPartition;
}) {
  switch (partition.kind) {
    case 'skills':
      return <SkillsDrilldown rows={partition.rows} />;
    case 'instruction-file':
      return <FilesDrilldown rows={partition.rows} />;
    case 'mcp-server':
      return <McpDrilldown rows={partition.rows} />;
    default:
      return <GenericRows rows={partition.rows} />;
  }
}
