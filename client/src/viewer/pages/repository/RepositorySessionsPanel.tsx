import { useRef } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { RepositorySession } from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import type { SessionLogsData } from '../../api';
import { useDraggableWidth } from '../../hooks/useDraggableWidth';
import {
  SessionListPanel,
  type ViewMode,
} from './session-list/SessionListPanel';
import { SessionDetailPane } from './SessionDetailPane';
import { SessionNotFoundState } from './SessionNotFoundState';
import type { ParsedSession } from './session-log/types';
import type { RepoConfig } from '../../../models/repositories';

import type { SessionTab } from './useRepositoryViewState';

export interface RepositorySessionsPanelProps {
  sessions: RepositorySession[];
  sessionsLoading: boolean;
  sessionsError: Error | null;
  selectedSession: RepositorySession | null;
  /** The URL names a session that no settled query holds. */
  isSessionNotFound: boolean;
  /** Clears the URL session selection — used by the not-found pane's Close button. */
  onSessionClose: () => void;
  onSessionSelect: (
    session: RepositorySession,
    viaAdvisorBadge?: boolean,
  ) => void;
  repoId: number;
  teamId?: number;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filterByUserEmail?: string;
  onShowAllUsers: () => void;
  sessionTab: SessionTab;
  onSessionTabChange: (tab: SessionTab) => void;
  isFavorite: boolean;
  favoriteMutationPending: boolean;
  onFavoriteToggle: (newValue: boolean) => void;
  showDeleteDialog: boolean;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  deleteLoading: boolean;
  logsQuery: UseQueryResult<SessionLogsData>;
  parsedLogs: ParsedSession | null;
  subagentLogsMap: Map<string, Record<string, unknown>[]>;
  agentParentMap: Map<string, string | null>;
  pricing: ModelPricingMap | null | undefined;
  repoConfig: RepoConfig | null;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
  repoUrl: string | undefined;
  sessionCost: number | null;
  hideHookSessions: boolean;
  isBranchOpen: (key: string, index: number) => boolean;
  onToggleBranch: (key: string, index: number) => void;
  isReloadingUpdatedSession: boolean;
}

export function RepositorySessionsPanel({
  sessions,
  sessionsLoading,
  sessionsError,
  selectedSession,
  isSessionNotFound,
  onSessionClose,
  onSessionSelect,
  repoId,
  teamId,
  viewMode,
  onViewModeChange,
  filterByUserEmail,
  onShowAllUsers,
  sessionTab,
  onSessionTabChange,
  isFavorite,
  favoriteMutationPending,
  onFavoriteToggle,
  showDeleteDialog,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  deleteLoading,
  logsQuery,
  parsedLogs,
  subagentLogsMap,
  agentParentMap,
  pricing,
  repoConfig,
  topN,
  onTopNChange,
  repoUrl,
  sessionCost,
  hideHookSessions,
  isBranchOpen,
  onToggleBranch,
  isReloadingUpdatedSession,
}: RepositorySessionsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { width: sessionListWidth, onMouseDown: handleSessionListDragStart } =
    useDraggableWidth({
      storageKey: 'artisyn:sessionListWidth',
      defaultWidth: 300,
      minWidth: 150,
      getMaxWidth: () =>
        panelRef.current ? panelRef.current.offsetWidth * 0.8 : Infinity,
    });

  return (
    <div ref={panelRef} className="flex h-full overflow-hidden">
      <div
        id="session-list"
        style={{ width: sessionListWidth }}
        className="shrink-0 flex flex-col overflow-hidden"
      >
        <SessionListPanel
          sessions={sessions}
          isLoading={sessionsLoading}
          error={sessionsError}
          selectedSession={selectedSession}
          onSelect={onSessionSelect}
          repoId={repoId}
          teamId={teamId}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          filterByUserEmail={filterByUserEmail}
          onShowAllUsers={onShowAllUsers}
          hideHookSessions={hideHookSessions}
          isBranchOpen={isBranchOpen}
          onToggleBranch={onToggleBranch}
        />
      </div>

      <div
        data-slot="resizable-handle"
        className="w-[5px] shrink-0 bg-border hover:bg-primary/30 transition-colors cursor-col-resize"
        onMouseDown={handleSessionListDragStart}
      />

      <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
        {isSessionNotFound ? (
          <SessionNotFoundState onClose={onSessionClose} />
        ) : selectedSession === null ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a session to view details
            </p>
          </div>
        ) : (
          // Keyed by session: switching sessions remounts the pane, resetting all per-tab
          // local state.
          <SessionDetailPane
            key={selectedSession.sessionId}
            selectedSession={selectedSession}
            sessionTab={sessionTab}
            onSessionTabChange={onSessionTabChange}
            isFavorite={isFavorite}
            favoriteMutationPending={favoriteMutationPending}
            onFavoriteToggle={onFavoriteToggle}
            repoId={repoId}
            teamId={teamId}
            showDeleteDialog={showDeleteDialog}
            onDeleteRequest={onDeleteRequest}
            onDeleteConfirm={onDeleteConfirm}
            onDeleteCancel={onDeleteCancel}
            deleteLoading={deleteLoading}
            logsQuery={logsQuery}
            parsedLogs={parsedLogs}
            subagentLogsMap={subagentLogsMap}
            agentParentMap={agentParentMap}
            pricing={pricing}
            repoConfig={repoConfig}
            topN={topN}
            onTopNChange={onTopNChange}
            repoUrl={repoUrl}
            sessionCost={sessionCost}
            isReloadingUpdatedSession={isReloadingUpdatedSession}
          />
        )}
      </div>
    </div>
  );
}
