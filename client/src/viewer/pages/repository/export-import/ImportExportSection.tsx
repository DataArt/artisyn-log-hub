import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import { ExportPanel } from './ExportPanel';
import { ImportPanel } from './ImportPanel';
import { SessionExportSection } from '../SessionExportSection';

// ---------------------------------------------------------------------------
// ImportExportSection — "Import/Export" subtab content.
// Renders inline (no Dialog) within RepositorySettings.tsx's
// `import-export` PageTabsContent. Its own Export session/Import
// session/Export Session statistics mode toggle uses ui/tabs.tsx's `line`
// variant (same primitive SessionChartsTab.tsx uses for its sub-tabs) and is
// itself URL-backed (`iemode` search param, distinct from the `stab` param
// the parent subtab bar owns) per the client navigation rule — never local
// useState. The `stats` mode hosts the SessionExportSection, moved here
// from its own top-level Settings subtab.
// ---------------------------------------------------------------------------

export type ImportExportMode = 'export' | 'import' | 'stats';

const IMPORT_EXPORT_MODES: readonly ImportExportMode[] = [
  'export',
  'import',
  'stats',
];

function parseImportExportMode(value: string | null): ImportExportMode {
  if (
    value != null &&
    (IMPORT_EXPORT_MODES as readonly string[]).includes(value)
  ) {
    return value as ImportExportMode;
  }
  return IMPORT_EXPORT_MODES[0];
}

interface ImportExportSectionProps {
  repoId: number;
  teamId?: number;
  readOnly: boolean;
}

export function ImportExportSection({
  repoId,
  teamId,
  readOnly,
}: ImportExportSectionProps) {
  const isTeamView = teamId !== undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = parseImportExportMode(searchParams.get('iemode'));

  function setMode(next: ImportExportMode) {
    const nextParams = new URLSearchParams(searchParams);
    if (next === IMPORT_EXPORT_MODES[0]) {
      nextParams.delete('iemode');
    } else {
      nextParams.set('iemode', next);
    }
    setSearchParams(nextParams, { replace: true });
  }

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as ImportExportMode)}>
      <TabsList variant="line" className="w-fit">
        <TabsTrigger value="export" className="flex-none">
          Export session
        </TabsTrigger>
        <TabsTrigger value="import" className="flex-none">
          Import session
        </TabsTrigger>
        <TabsTrigger value="stats" className="flex-none">
          Export Session statistics
        </TabsTrigger>
      </TabsList>

      <TabsContent value="export" className="pt-4">
        <ExportPanel repoId={repoId} teamId={teamId} readOnly={readOnly} />
      </TabsContent>

      <TabsContent value="import" className="pt-4">
        <ImportPanel repoId={repoId} teamId={teamId} readOnly={readOnly} />
      </TabsContent>

      <TabsContent value="stats" className="pt-4">
        <SessionExportSection
          repoId={repoId}
          teamId={teamId}
          isTeamView={isTeamView}
          readOnly={readOnly}
        />
      </TabsContent>
    </Tabs>
  );
}
