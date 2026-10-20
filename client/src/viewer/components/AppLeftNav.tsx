import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Key,
  Plus,
  ShieldCheck,
  Upload,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import type { Team } from '../../models/teams';
import type { HookRepositorySummary } from '../../models/hook-state';
import {
  fetchApiKeys,
  fetchHookRepositories,
  fetchMyRepositories,
  fetchTeams,
  type UserRepository,
} from '../api';
import { useAuth } from '../context/AuthContext';
import { routes } from '../hooks/useHashRoute';
import { CreateTeamDialog } from './CreateTeamDialog';
import { ImportRepoSessionsDialog } from './ImportRepoSessionsDialog';
import { TeamAccordionList } from './TeamAccordion';

// Stable empty-array default prevents useMemo(adminOnlyTeams) from getting a new
// reference on every render while the teams query is still loading.
const EMPTY_TEAMS: Team[] = [];

export function AppLeftNav({ isCollapsed = false }: { isCollapsed?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ repoId?: string; teamId?: string }>();
  const { user } = useAuth();
  const [expandedTeamIds, setExpandedTeamIds] = useState<Set<number>>(
    new Set(),
  );
  const [adminSectionOpen, setAdminSectionOpen] = useState(false);
  const [myReposOpen, setMyReposOpen] = useState(true);
  const [hookSectionOpen, setHookSectionOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [importingRepo, setImportingRepo] = useState(false);

  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const { data: teams = EMPTY_TEAMS } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const { data: apiKeys = [] } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
  });

  const { data: hookRepos = [] } = useQuery({
    queryKey: ['hook-repos'],
    queryFn: fetchHookRepositories,
    refetchInterval: 60_000,
    // Per-query override of the global `refetchOnWindowFocus: false` (main.tsx), like
    // NotificationBell: returning to the tab shows a new hook repo without a reload.
    refetchOnWindowFocus: true,
  });

  const isAdmin = user?.role === 'admin';
  const isTeamOwner = teams.some((t) => t.ownerId === user?.id);
  const myTeams = useMemo(
    () => teams.filter((t: Team) => t.isMember !== false),
    [teams],
  );
  const adminOnlyTeams = useMemo(
    () => (isAdmin ? teams.filter((t: Team) => t.isMember === false) : []),
    [teams, isAdmin],
  );

  const activeTeamId = params.teamId ? parseInt(params.teamId, 10) : null;
  const activeRepoId = params.repoId ? parseInt(params.repoId, 10) : null;
  const isTeamRoute =
    location.pathname.startsWith('/teams/') && params.repoId != null;
  const isHookStateRoute = location.pathname.endsWith('/hook-state');
  const isMyRepoRoute =
    location.pathname.startsWith('/repos/') && !isHookStateRoute;
  const isApiKeysRoute = location.pathname === '/api-keys';
  const isAdminRoute = location.pathname === '/admin';
  const showInstalledHooks = apiKeys.length > 0;

  useEffect(() => {
    if (activeTeamId != null) {
      setExpandedTeamIds((prev) => new Set([...prev, activeTeamId]));
      if (adminOnlyTeams.some((t) => t.id === activeTeamId)) {
        setAdminSectionOpen(true);
      }
    }
  }, [activeTeamId, adminOnlyTeams]);

  const {
    data: myRepos = [],
    error: myReposError,
    isSuccess: myReposSuccess,
  } = useQuery({
    queryKey: ['my-repos'],
    queryFn: fetchMyRepositories,
    // A first upload creates a repo while the page is open — poll and refetch on focus so
    // "My Repos" shows it without a reload (C). Overrides the global focus default.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if ((isTeamRoute || isMyRepoRoute) && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isTeamRoute, isMyRepoRoute, activeRepoId]);

  const showMyRepos = myReposSuccess && myRepos.length > 0;

  function toggleTeam(id: number) {
    setExpandedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isCollapsed) {
    return (
      <nav className="flex flex-col items-center gap-1 py-2 h-full">
        <button
          title="Teams"
          onClick={() => navigate(routes.teams)}
          className="flex items-center justify-center p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <Users className="size-4" />
        </button>
        <div
          title="My Repos"
          className="flex items-center justify-center p-1.5 text-muted-foreground/40"
        >
          <FolderGit2 className="size-4" />
        </div>
        <div className="flex-1" />
        <button
          title="My API Keys"
          onClick={() => navigate(routes.apiKeys)}
          className="flex items-center justify-center p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <Key className="size-4" />
        </button>
        {(isAdmin || isTeamOwner) && (
          <button
            title="Admin Panel"
            onClick={() => navigate(routes.admin)}
            className="flex items-center justify-center p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ShieldCheck className="size-4" />
          </button>
        )}
      </nav>
    );
  }

  return (
    <nav className="flex flex-col h-full py-2 text-sm">
      {/* Teams section header */}
      <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60 bg-muted/30 border-b border-border/40">
        Teams
      </div>

      <div className="flex flex-col mt-0.5">
        <TeamAccordionList
          teams={myTeams}
          expandedTeamIds={expandedTeamIds}
          onToggleTeam={toggleTeam}
          activeTeamId={activeTeamId}
          activeRepoId={activeRepoId}
          activeItemRef={activeItemRef}
        />

        <button
          className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors text-left w-full"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5 shrink-0" />
          <span>Add Team</span>
        </button>

        <CreateTeamDialog open={creating} onClose={() => setCreating(false)} />
      </div>

      {/* My Repos section */}
      {(showMyRepos || !!myReposError) && (
        <>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 mt-1 w-full text-xs font-semibold uppercase tracking-wide text-muted-foreground/60 bg-muted/30 border-b border-border/40 hover:bg-muted/50 transition-colors"
            onClick={() => setMyReposOpen((v) => !v)}
          >
            {myReposOpen ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            My Repos
          </button>

          {myReposOpen && (
            <div className="flex flex-col mt-0.5">
              {myReposError ? (
                <p className="px-3 py-1.5 text-xs text-destructive">
                  {myReposError instanceof Error
                    ? myReposError.message
                    : 'Failed to load repositories'}
                </p>
              ) : (
                myRepos.map((repo: UserRepository) => {
                  const isActive = repo.id === activeRepoId && isMyRepoRoute;
                  return (
                    <button
                      key={repo.id}
                      ref={isActive ? activeItemRef : null}
                      title={repo.repoUrl}
                      className={`flex items-center px-3 py-1.5 transition-colors text-left w-full truncate ${
                        isActive
                          ? 'bg-accent text-foreground font-medium'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                      onClick={() => navigate(routes.repo(repo.id))}
                    >
                      {repo.repoUrl}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      <button
        className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors text-left w-full"
        onClick={() => setImportingRepo(true)}
      >
        <Upload className="size-3.5 shrink-0" />
        <span>Import repo sessions</span>
      </button>

      <ImportRepoSessionsDialog
        open={importingRepo}
        onClose={() => setImportingRepo(false)}
      />

      {/* Teams as Admin accordion — admin-only */}
      {isAdmin && adminOnlyTeams.length > 0 && (
        <>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 mt-1 w-full text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/20 border-y border-blue-200 dark:border-blue-900 hover:bg-blue-100 dark:hover:bg-blue-950/30 transition-colors"
            onClick={() => setAdminSectionOpen((v) => !v)}
          >
            {adminSectionOpen ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            Teams as Admin
          </button>

          {adminSectionOpen && (
            <div className="flex flex-col mt-0.5">
              <TeamAccordionList
                teams={adminOnlyTeams}
                expandedTeamIds={expandedTeamIds}
                onToggleTeam={toggleTeam}
                activeTeamId={activeTeamId}
                activeRepoId={activeRepoId}
                activeItemRef={activeItemRef}
              />
            </div>
          )}
        </>
      )}

      {/* Divider */}
      <div className="my-1 mx-3 border-t border-border" />

      {/* API Keys item */}
      <button
        className={`flex items-center gap-2 px-3 py-1.5 transition-colors text-left w-full ${
          isApiKeysRoute
            ? 'bg-accent text-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        }`}
        onClick={() => navigate(routes.apiKeys)}
      >
        <Key className="size-3.5 shrink-0" />
        <span>My API Keys</span>
      </button>

      {/* Installed Hooks section — shown once the user has >=1 API key */}
      {showInstalledHooks && (
        <>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 mt-1 w-full text-xs font-semibold uppercase tracking-wide text-muted-foreground/60 bg-muted/30 border-b border-border/40 hover:bg-muted/50 transition-colors"
            onClick={() => setHookSectionOpen((v) => !v)}
          >
            {hookSectionOpen ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            Installed Hooks
          </button>

          {hookSectionOpen && (
            <div className="flex flex-col mt-0.5">
              {hookRepos.map((repo: HookRepositorySummary) => {
                const isActive = repo.id === activeRepoId && isHookStateRoute;
                const hasIssues = repo.issueCount > 0;
                const rowClasses = hasIssues
                  ? 'bg-orange-50 dark:bg-orange-950/20 border-l-2 border-orange-500 text-foreground hover:bg-orange-100 dark:hover:bg-orange-950/30'
                  : isActive
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground';
                return (
                  <button
                    key={repo.id}
                    title={repo.repoUrl}
                    className={`flex items-center gap-2 px-3 py-1.5 transition-colors text-left w-full ${rowClasses}`}
                    onClick={() => navigate(routes.hookState(repo.id))}
                  >
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${
                        hasIssues ? 'bg-orange-500' : 'bg-green-500'
                      }`}
                    />
                    <span className="flex-1 min-w-0 truncate">
                      {repo.repoUrl}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] font-semibold ${
                        hasIssues
                          ? 'text-orange-600 dark:text-orange-400'
                          : 'text-green-600 dark:text-green-400'
                      }`}
                    >
                      {hasIssues
                        ? `${repo.issueCount} issue${repo.issueCount > 1 ? 's' : ''}`
                        : 'OK'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Admin Panel item — admin or team-owner */}
      {(isAdmin || isTeamOwner) && (
        <>
          <div className="mx-3 border-t border-border" />
          <button
            className={`flex items-center gap-2 px-3 py-1.5 transition-colors text-left w-full ${
              isAdminRoute
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`}
            onClick={() => navigate(routes.admin)}
          >
            <ShieldCheck className="size-3.5 shrink-0" />
            <span>Admin Panel</span>
          </button>
        </>
      )}
    </nav>
  );
}
