/**
 * The shared OKF view of the repository tab and the session tab: a summary line and four views —
 * Versions, Wrong format, Hot files and Explorer. The tabs only fetch and pass `data`; the unit
 * (sessions / agents) comes from `data.unit`.
 *
 * Without a KB snapshot the whole view is one line. For a snapshot from a hook that sends no
 * metadata, one line replaces Versions and Wrong format; the rest works as usual. Below `56rem`
 * of its own width (a container query — the session pane is narrower than the viewport) the
 * pairs stack: Versions, Wrong format, Hot files, Explorer.
 */
import type { OkfUsageResponse } from '../../../../../models/repositories';
import { OkfExplorer } from './OkfExplorer';
import { OkfHotFilesTable } from './OkfHotFilesTable';
import { OkfNoSnapshotLine } from './OkfNoSnapshotLine';
import { OkfSummaryLine } from './OkfSummaryLine';
import { OkfOldHookLine, OkfVersionsBlock } from './OkfVersionsBlock';
import { OkfWrongFormatBlock } from './OkfWrongFormatBlock';

export function OkfUsageView({ data }: { data: OkfUsageResponse }) {
  if (data.snapshot === null) return <OkfNoSnapshotLine />;

  return (
    <div className="@container space-y-3">
      <OkfSummaryLine
        unit={data.unit}
        summary={data.summary}
        snapshot={data.snapshot}
      />
      {data.snapshot.hasMeta && data.format !== null ? (
        <div className="grid grid-cols-1 items-start gap-3 @[56rem]:grid-cols-2">
          <OkfVersionsBlock
            versions={data.versions}
            currentFormat={data.currentFormat}
          />
          <OkfWrongFormatBlock format={data.format} />
        </div>
      ) : (
        <OkfOldHookLine />
      )}
      <div className="grid grid-cols-1 items-start gap-3 @[56rem]:grid-cols-[minmax(0,4fr)_minmax(0,3fr)]">
        <OkfHotFilesTable
          files={data.files}
          unit={data.unit}
          readsWithoutCost={data.summary.readsWithoutCost}
        />
        <OkfExplorer
          files={data.files}
          folders={data.folders}
          versions={data.versions}
          unit={data.unit}
          notInSnapshotUnits={data.notInSnapshotUnits}
        />
      </div>
    </div>
  );
}
