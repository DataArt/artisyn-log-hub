import {
  type DirGroup,
  displayGroups,
} from '../../../../lib/bash-view/bash-analyze';
import type { BashFiles } from '../../../../lib/bash-view/bash-view';

const GROUPS: {
  key: 'changes' | 'reads' | 'runs' | 'inline';
  label: string;
}[] = [
  { key: 'changes', label: 'Changes' },
  { key: 'reads', label: 'Reads' },
  { key: 'runs', label: 'Runs' },
  { key: 'inline', label: 'Inline' },
];

function PathList({
  paths,
  groups,
}: {
  paths: string[];
  groups: DirGroup[] | null;
}) {
  if (!groups)
    return (
      <ul className="flex flex-col">
        {paths.map((p, i) => (
          <li key={i} className="break-all">
            {p}
          </li>
        ))}
      </ul>
    );
  return (
    <ul className="flex flex-col">
      {groups.map(({ dir, names }) => (
        <li key={dir} className="break-all">
          <span className="text-muted-foreground">{dir}</span>{' '}
          {names.join(', ')}
        </li>
      ))}
    </ul>
  );
}

/**
 * The FILES block of the Bash view (DD-13): Changes / Reads / Runs / Inline, empty groups hidden;
 * a path list (Changes / Reads) with more than `GROUP_BY_DIR_ABOVE` entries is grouped by
 * directory (`displayGroups`). Runs and Inline are never grouped.
 */
export function BashFileSummary({ files }: { files: BashFiles }) {
  const groups = GROUPS.filter(({ key }) => files[key].length > 0);
  if (groups.length === 0) return null;
  return (
    <div data-testid="bash-files">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        Files
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {groups.map(({ key, label }) => (
          <div key={key} className="contents" data-testid={`bash-files-${key}`}>
            <span className="text-muted-foreground">{label}</span>
            <PathList
              paths={files[key]}
              groups={displayGroups(key, files[key])}
            />
          </div>
        ))}
      </div>
      {files.unresolved > 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          + {files.unresolved} not resolved (non-literal paths)
        </div>
      )}
    </div>
  );
}
