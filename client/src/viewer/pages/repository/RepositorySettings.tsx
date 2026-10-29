import { useRef, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { RepoConfig } from '../../../models/repositories';
import { getRepoSettings, putTeamConfig, putUserConfig } from '../../api';
import { DEFAULT_REPO_CONFIG } from './session-log/log-parser';
import {
  ConfigEditor,
  configToRows,
  rowsToConfig,
  type CategoryRow,
} from './FileCategoriesEditor';
import { MaintenanceSection } from './MaintenanceSection';
import { MonitoredToolsSettings } from './tools/MonitoredToolsSettings';
import { ImportExportSection } from './export-import/ImportExportSection';
import {
  SessionAttributionSettings,
  type SessionAttributionValue,
} from './SessionAttributionSettings';
import {
  CacheCreationThresholdSetting,
  TurnEndCostAdvisorSetting,
} from './AnalysisSettings';
import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { DEFAULT_HIGH_CACHE_CREATION_THRESHOLD } from '../../lib/cache-ratio-ui';
import { DEFAULT_SESSION_ATTRIBUTION_ATTRIBUTES } from '../../lib/session-attribution-ui';
import {
  SETTINGS_TABS,
  useRepositorySettingsTabState,
  type SettingsTab,
} from './useRepositorySettingsTabState';

const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  display: 'Display',
  'file-categories': 'File Categories',
  analysis: 'Analysis',
  'monitored-tools': 'Monitored Tools',
  'session-attribution': 'Session Attributes',
  maintenance: 'Maintenance',
  'import-export': 'Import/Export',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  repoId: number;
  teamId?: number;
  hideHookSessions: boolean;
  onHideHookSessionsChange: (value: boolean) => void;
}

// ---------------------------------------------------------------------------
// RepositorySettings — inline settings panel
// ---------------------------------------------------------------------------

export function RepositorySettings({
  repoId,
  teamId,
  hideHookSessions,
  onHideHookSessionsChange,
}: Props) {
  const isTeamView = teamId !== undefined;
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
  });

  const data = settingsQuery.data;

  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [initialRows, setInitialRows] = useState<CategoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Sync rows when data arrives
  const prevDataRef = useRef<typeof data>(undefined);
  if (data !== prevDataRef.current) {
    prevDataRef.current = data;
    if (data) {
      const r = isTeamView
        ? data.teamConfig
          ? configToRows(data.teamConfig)
          : configToRows(DEFAULT_REPO_CONFIG)
        : data.userConfig
          ? configToRows(data.userConfig)
          : [];
      setRows(r);
      setInitialRows(r);
      setLoaded(true);
    }
  }

  const mutation = useMutation({
    mutationFn: (config: RepoConfig | null) =>
      isTeamView
        ? putTeamConfig(repoId, config, teamId)
        : putUserConfig(repoId, config),
    onSuccess: (result) => {
      queryClient.setQueryData(
        ['repoSettings', repoId, teamId ?? null],
        result,
      );
      void queryClient.invalidateQueries({ queryKey: ['repo-detail', repoId] });
      const r = isTeamView
        ? result.teamConfig
          ? configToRows(result.teamConfig)
          : configToRows(DEFAULT_REPO_CONFIG)
        : result.userConfig
          ? configToRows(result.userConfig)
          : [];
      setRows(r);
      setInitialRows(r);
    },
  });

  const hasChanges = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(initialRows),
    [rows, initialRows],
  );

  const currentConfig = useMemo<RepoConfig>(() => {
    if (!isTeamView && rows.length === 0)
      return data?.effectiveConfig ?? DEFAULT_REPO_CONFIG;
    return rowsToConfig(rows);
  }, [rows, isTeamView, data]);

  const canEditTeam = data?.canEditTeamConfig ?? false;
  const readOnly = isTeamView && !canEditTeam;

  // The high cache-creation threshold and the Turn-End Cost Advisor
  // config live in the same `RepoConfig` blob as the file categories, so every save path
  // must carry the other two's value through untouched.
  const savedScopeConfig =
    (isTeamView ? data?.teamConfig : data?.userConfig) ?? null;
  const savedThreshold = savedScopeConfig?.highCacheCreationThreshold;
  const effectiveThreshold =
    data?.effectiveConfig.highCacheCreationThreshold ??
    DEFAULT_HIGH_CACHE_CREATION_THRESHOLD;

  const savedTurnEndCostAdvisor = savedScopeConfig?.turnEndCostAdvisor;
  const effectiveTurnEndCostAdvisor = data?.effectiveConfig
    .turnEndCostAdvisor ?? { enabled: false };

  /**
   * Adds the scope's saved threshold and advisor config back onto a config built from the
   * category rows (`rowsToConfig()` only ever sets `fileCategories`).
   */
  function withSavedAnalysisSettings(config: RepoConfig): RepoConfig {
    let result = config;
    if (savedThreshold !== undefined) {
      result = { ...result, highCacheCreationThreshold: savedThreshold };
    }
    if (savedTurnEndCostAdvisor !== undefined) {
      result = { ...result, turnEndCostAdvisor: savedTurnEndCostAdvisor };
    }
    return result;
  }

  /** Read-modify-write: keep the whole current config, replace only the threshold. */
  function saveThreshold(value: number) {
    const base: RepoConfig =
      savedScopeConfig ?? data?.effectiveConfig ?? DEFAULT_REPO_CONFIG;
    mutation.mutate({ ...base, highCacheCreationThreshold: value });
  }

  /**
   * Read-modify-write: keep the whole current config, replace only `enabled` on the advisor
   * config — the UI no longer exposes `minSessionCostUsd`, so an already-stored value (kept
   * for an un-upgraded hook's backward compatibility) round-trips unchanged.
   */
  function saveTurnEndCostAdvisor(value: { enabled: boolean }) {
    const base: RepoConfig =
      savedScopeConfig ?? data?.effectiveConfig ?? DEFAULT_REPO_CONFIG;
    mutation.mutate({
      ...base,
      turnEndCostAdvisor: {
        ...base.turnEndCostAdvisor,
        enabled: value.enabled,
      },
    });
  }

  // AI Session Attribution is genuinely team-only: it is
  // never saved on a personal `repo_config` row, so unlike every other tab above it always
  // targets `putTeamConfig` regardless of whether this panel is currently open in team view or
  // personal view (`isTeamView`/`mutation` above route to whichever scope the *page* is in).
  // `data.teamId`/`data.canEditTeamConfig` are the page's team in team view (`teamId` is
  // passed through) and the server's lowest-id team for the URL in personal view, so they are
  // the correct signals here.
  const hasTeamForAttribution = (data?.teamId ?? null) !== null;
  const savedSessionAttribution = data?.teamConfig?.sessionAttribution;
  const effectiveSessionAttribution: SessionAttributionValue =
    savedSessionAttribution ??
    (hasTeamForAttribution
      ? { enabled: true, attributes: DEFAULT_SESSION_ATTRIBUTION_ATTRIBUTES }
      : { enabled: false, attributes: [] });
  const savedSessionAttributionKeys =
    savedSessionAttribution?.attributes.map((a) => a.key) ?? [];

  const sessionAttributionMutation = useMutation({
    mutationFn: (value: SessionAttributionValue) => {
      const base: RepoConfig =
        data?.teamConfig ?? data?.effectiveConfig ?? DEFAULT_REPO_CONFIG;
      return putTeamConfig(
        repoId,
        { ...base, sessionAttribution: value },
        teamId,
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ['repoSettings', repoId, teamId ?? null],
        result,
      );
      void queryClient.invalidateQueries({ queryKey: ['repo-detail', repoId] });
    },
  });

  const { tab, setTab } = useRepositorySettingsTabState();

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <PageTabs
        tabs={SETTINGS_TABS.map((t) => ({
          value: t,
          label: SETTINGS_TAB_LABELS[t],
        }))}
        value={tab}
        onValueChange={(v) => setTab(v as SettingsTab)}
        className="flex flex-col flex-1 min-h-0"
        testIdGroup="settings"
      >
        <PageTabsContent
          value="display"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideHookSessions}
                onChange={(e) => onHideHookSessionsChange(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
              />
              <span className="text-sm">Hide hook-service sessions</span>
            </label>
            <p className="mt-1 ml-5 text-xs text-muted-foreground">
              The hook&apos;s turn-end advisor and session-attribution LLM calls
              run as background sessions — hide them from the session list by
              default.
            </p>
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="file-categories"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            {isTeamView && !canEditTeam && loaded && (
              <p className="mb-3 text-xs font-medium text-muted-foreground">
                Managed by team owner
              </p>
            )}

            {settingsQuery.isLoading && (
              <div className="flex items-center gap-2 py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {settingsQuery.error && (
              <p className="text-sm text-destructive">
                Failed to load settings. Please try again.
              </p>
            )}

            {loaded && data && (
              <ConfigEditor
                rows={rows}
                readOnly={readOnly}
                hasChanges={hasChanges}
                isSaving={mutation.isPending}
                onRowsChange={setRows}
                onSave={() =>
                  mutation.mutate(withSavedAnalysisSettings(rowsToConfig(rows)))
                }
                onReset={() => mutation.mutate(null)}
                currentConfig={currentConfig}
                resetLabel={
                  isTeamView ? 'Reset to defaults' : 'Delete override'
                }
                resetConfirmMessage={
                  isTeamView
                    ? 'This will clear all custom team categories and reset to built-in defaults.'
                    : 'This will delete your personal category overrides and use built-in defaults.'
                }
                emptyState={
                  !isTeamView &&
                  data.userConfig === null &&
                  rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Using built-in defaults — customise below
                    </p>
                  ) : undefined
                }
              />
            )}
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="analysis"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            {settingsQuery.isLoading && (
              <div className="flex items-center gap-2 py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {settingsQuery.error && (
              <p className="text-sm text-destructive">
                Failed to load settings. Please try again.
              </p>
            )}

            {loaded && data && (
              <div className="flex flex-col gap-8">
                <CacheCreationThresholdSetting
                  key={effectiveThreshold}
                  initialValue={effectiveThreshold}
                  readOnly={readOnly}
                  isSaving={mutation.isPending}
                  onSave={saveThreshold}
                />
                <div className="border-t border-border pt-8">
                  <TurnEndCostAdvisorSetting
                    key={JSON.stringify(effectiveTurnEndCostAdvisor)}
                    initialValue={effectiveTurnEndCostAdvisor}
                    readOnly={readOnly}
                    isSaving={mutation.isPending}
                    onSave={saveTurnEndCostAdvisor}
                  />
                </div>
              </div>
            )}
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="monitored-tools"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-3xl">
            <MonitoredToolsSettings repoId={repoId} teamId={teamId} />
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="session-attribution"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            {settingsQuery.isLoading && (
              <div className="flex items-center gap-2 py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {settingsQuery.error && (
              <p className="text-sm text-destructive">
                Failed to load settings. Please try again.
              </p>
            )}

            {loaded && data && (
              <SessionAttributionSettings
                key={JSON.stringify(effectiveSessionAttribution)}
                initialValue={effectiveSessionAttribution}
                savedKeys={savedSessionAttributionKeys}
                noTeam={!hasTeamForAttribution}
                readOnly={!canEditTeam}
                isSaving={sessionAttributionMutation.isPending}
                onSave={(value) => sessionAttributionMutation.mutate(value)}
              />
            )}
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="maintenance"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            <MaintenanceSection
              repoId={repoId}
              teamId={teamId}
              readOnly={readOnly}
            />
          </div>
        </PageTabsContent>

        <PageTabsContent
          value="import-export"
          className="flex-1 min-h-0 overflow-auto p-6"
        >
          <div className="max-w-2xl">
            <ImportExportSection
              repoId={repoId}
              teamId={teamId}
              readOnly={readOnly}
            />
          </div>
        </PageTabsContent>
      </PageTabs>
    </div>
  );
}
