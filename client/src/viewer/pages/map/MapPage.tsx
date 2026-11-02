/**
 * `#/map` — "All views" (FR-E1–E10): every screen, tab, view, report, setting and help article
 * of the viewer as one filterable tree. `q=` keeps the filter in the URL; `teamId`, `repoId`
 * and `session` scope the tree to a context (the rail, read by `useNavTreeInput`).
 *
 * A node whose context is missing opens the picker; the pick fills the rail and then opens that
 * node (FR-E3). Esc on an empty filter, or "Back", returns to the page the map was opened from
 * (`state.from`, DD-18); Ctrl/Cmd+K while the map is open focuses the filter.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  isMapOpenState,
  MAP_FOCUS_FILTER_EVENT,
} from '../../hooks/useAllViewsShortcut';
import { routes } from '../../hooks/useHashRoute';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { contextPath, findNode, repoIdOfNode } from './map-tree-model';
import { MapContextRail } from './MapContextRail';
import { MapQuestions } from './MapQuestions';
import { MapSessionPicker, type MapPickerRequest } from './MapSessionPicker';
import { MapTree, type MapTreeHandle } from './MapTree';
import {
  buildNavTree,
  matchNavFilter,
  type NavNode,
  type NavRepo,
  type NavTeam,
} from './nav-tree';
import { useMapActivate } from './useMapActivate';
import { useNavTreeInput } from './useNavTreeInput';

const HelpModal = lazy(() =>
  import('../../help/HelpModal').then((m) => ({ default: m.HelpModal })),
);

export function MapPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { input, rail, loading, repos, repoEntries, teams, recent, setRail } =
    useNavTreeInput();
  const { activate, helpSlug, closeHelp } = useMapActivate();
  const filterRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<MapTreeHandle | null>(null);

  // Local state keeps typing smooth; every change is mirrored into `q=` without a history entry
  // (the router state is kept, so Back still knows where the map was opened from).
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const writeQuery = (value: string) => {
    setQuery(value);
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true, state: location.state });
  };
  const onQueryChange = (e: ChangeEvent<HTMLInputElement>) =>
    writeQuery(e.target.value);

  const tree = useMemo(() => buildNavTree(input), [input]);
  const trimmed = query.trim();
  const filter = useMemo(
    () => (trimmed ? matchNavFilter(tree, trimmed) : null),
    [tree, trimmed],
  );
  const total = useMemo(
    () => filter?.total ?? matchNavFilter(tree, '').total,
    [filter, tree],
  );
  const shown = filter ? filter.matches.length : total;

  const questions = tree.find((n) => n.id === 'questions')?.children ?? [];
  const treeNodes = useMemo(
    () => tree.filter((n) => n.id !== 'questions'),
    [tree],
  );
  const openPath = useMemo(() => contextPath(rail), [rail]);

  const focusFilter = useCallback(() => {
    filterRef.current?.focus();
    filterRef.current?.select();
  }, []);

  // A door used while the map is open (Ctrl/Cmd+K, the top-nav button) focuses the filter.
  useEffect(() => {
    window.addEventListener(MAP_FOCUS_FILTER_EVENT, focusFilter);
    return () =>
      window.removeEventListener(MAP_FOCUS_FILTER_EVENT, focusFilter);
  }, [focusFilter]);

  const goBack = useCallback(() => {
    if (isMapOpenState(location.state)) void navigate(-1);
    else void navigate(routes.main);
  }, [location.state, navigate]);

  // --- Missing context: picker, then the clicked node (FR-E3) ---------------------------------
  const [picker, setPicker] = useState<MapPickerRequest | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);

  const openPicker = useCallback((request: MapPickerRequest) => {
    setPickerKey((k) => k + 1);
    setPicker(request);
  }, []);

  const onActivate = useCallback(
    (node: NavNode) => {
      if (!node.needs) {
        activate(node);
        return;
      }
      const isLeaf = node.kind === 'leaf';
      openPicker({
        needs: node.needs,
        repoId: node.needs === 'session' ? repoIdOfNode(node.id) : undefined,
        nodeId: isLeaf ? node.id : undefined,
        nodeLabel: isLeaf ? node.label : undefined,
      });
    },
    [activate, openPicker],
  );

  const afterPick = () => {
    setPendingNodeId(picker?.nodeId ?? null);
    setPicker(null);
  };
  const onPickSession = (repo: NavRepo, sessionId: string) => {
    setRail({ teamId: repo.teamId, repoId: repo.id, sessionId });
    afterPick();
  };
  const onPickRepo = (repo: NavRepo) => {
    setRail({ teamId: repo.teamId, repoId: repo.id });
    afterPick();
  };
  const onPickTeam = (team: NavTeam) => {
    const repo = repos.find((r) => r.id === rail.repoId);
    const keepRepo = repo !== undefined && repo.teamId === team.id;
    setRail({
      teamId: team.id,
      repoId: keepRepo ? repo.id : undefined,
      sessionId: keepRepo ? rail.sessionId : undefined,
    });
    afterPick();
  };

  // Once the tree carries the picked context, the clicked node opens. A node that still needs
  // context waits for the rebuilt tree; one that no longer exists or has no target is dropped.
  useEffect(() => {
    if (pendingNodeId === null) return;
    const node = findNode(tree, pendingNodeId);
    if (node?.needs !== undefined) return;
    if (!node && loading) return;
    setPendingNodeId(null);
    if (node?.target) activate(node);
  }, [pendingNodeId, tree, loading, activate]);

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc clears the filter first (FR-E4); on an empty filter it returns (FR-E7).
      if (query) writeQuery('');
      else goBack();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      treeRef.current?.focusTree();
    } else if (e.key === 'Enter' && filter && filter.matches.length > 0) {
      // Enter opens the first match, like picking it in the tree.
      const node = findNode(tree, filter.matches[0]);
      if (node) {
        e.preventDefault();
        onActivate(node);
      }
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="map-back"
            onClick={goBack}
            aria-label="Back"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <LayoutGrid className="size-5" aria-hidden />
          <h1 className="text-xl font-semibold">All views</h1>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={filterRef}
              data-testid="map-filter"
              type="search"
              autoFocus
              value={query}
              onChange={onQueryChange}
              onKeyDown={onFilterKeyDown}
              placeholder="Filter views: cost, failed tools, CLAUDE.md…"
              aria-label="Filter views"
              className="pl-9"
            />
          </div>
          <p
            data-testid="map-counter"
            className="text-xs text-muted-foreground"
            aria-live="polite"
          >
            {shown} of {total} views
            {loading && ' · loading repositories…'}
          </p>
        </div>

        <MapContextRail
          rail={rail}
          repos={repos}
          repoEntries={repoEntries}
          teams={teams}
          recent={recent}
          onChange={setRail}
          onChooseSession={() => {
            if (rail.repoId !== undefined)
              openPicker({ needs: 'session', repoId: rail.repoId });
          }}
        />

        <MapQuestions
          questions={questions}
          query={trimmed}
          filter={filter}
          onActivate={onActivate}
        />

        <MapTree
          nodes={treeNodes}
          query={trimmed}
          filter={filter}
          userId={user?.id}
          openPath={openPath}
          onActivate={onActivate}
          onFocusFilter={focusFilter}
          handleRef={treeRef}
        />
      </div>

      <MapSessionPicker
        key={pickerKey}
        request={picker}
        repos={repos}
        teams={teams}
        recent={recent}
        onPickSession={onPickSession}
        onPickRepo={onPickRepo}
        onPickTeam={onPickTeam}
        onClose={() => setPicker(null)}
      />

      {helpSlug !== null && (
        <Suspense fallback={null}>
          <HelpModal
            open
            onOpenChange={(open) => {
              if (!open) closeHelp();
            }}
            initialSlug={helpSlug}
          />
        </Suspense>
      )}
    </div>
  );
}
