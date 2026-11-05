/**
 * The Live view modal (2026-11-04 otel-live-view): a 90 % × 90 % dialog with the node tree on the
 * left, the selected node's view in the middle and the details panel on the right (only while a
 * `panelKey` is set). Mounted by `LiveNavItem` while `?live=` is in the URL (DD-15).
 *
 * Polls `GET /api/v1/otel/live` every `OTEL_SESSION_POLL_MS` through `useOtelLivePoll` (DD-14):
 * the step reads the node / panel keys from refs, and a selection or panel change aborts the
 * request in flight and polls at once (`refreshAbortsInFlight`). On error the last state stays on
 * screen under the FR-13 banner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchOtelLive } from '../api';
import type {
  OtelLiveDetails,
  OtelLiveNode,
  OtelLiveResponse,
} from '../../models/otel-live';
import { Dialog, DialogContent } from '../ui/dialog';
import {
  EMPTY_OTEL_NEW_KEYS,
  NO_OTEL_FILLED,
} from '../pages/repository/otel/otel-merge';
import { OTEL_SESSION_POLL_MS } from '../pages/repository/otel/otel.constants';
import {
  type OtelPollStep,
  useOtelLivePoll,
} from '../pages/repository/otel/useOtelLivePoll';
import { formatLiveClock } from './live-format';
import { HOME_LIVE_KEY } from './live-node-key';
import { useDraggableWidth } from '../hooks/useDraggableWidth';
import {
  LIVE_DETAILS_MIN_WIDTH_PX,
  LIVE_DETAILS_WIDTH_PX,
  LIVE_TREE_MIN_WIDTH_PX,
  LIVE_TREE_WIDTH_PX,
  LIVE_VIEW_MIN_WIDTH_PX,
} from './live.constants';
import { LiveDetailsPanel } from './LiveDetailsPanel';
import { LiveModalHeader } from './LiveModalHeader';
import { LiveSplitter } from './LiveSplitter';
import { LiveTree } from './LiveTree';
import { LiveViewPane } from './LiveViewPane';
import { useLiveUrlState } from './useLiveUrlState';

/** One poll answer plus the keys it was requested for, so a stale answer is recognisable. */
export interface LivePollState {
  res: OtelLiveResponse;
  node: string;
  panel: string | null;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The node the details panel shows: matched by the panel key or by the canonical details key. */
function findPanelNode(
  res: OtelLiveResponse | null,
  panelKey: string | null,
  details: OtelLiveDetails | null,
): OtelLiveNode | null {
  if (res === null || panelKey === null) return null;
  const keys = new Set([panelKey]);
  if (details !== null) keys.add(details.key);
  const pools = [res.nodes, res.view.breakdown, details?.agents ?? []];
  for (const pool of pools) {
    const hit = pool.find((n) => keys.has(n.key));
    if (hit) return hit;
  }
  return null;
}

export function LiveModal() {
  const { liveKey, select, close } = useLiveUrlState();
  const node = liveKey ?? HOME_LIVE_KEY;
  const [panelKey, setPanelKey] = useState<string | null>(null);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const tz = useMemo(browserTimeZone, []);

  const nodeRef = useRef(node);
  nodeRef.current = node;
  const panelRef = useRef(panelKey);
  panelRef.current = panelKey;

  // Both splitters are draggable; the middle pane keeps at least LIVE_VIEW_MIN_WIDTH_PX.
  const panesRef = useRef<HTMLDivElement | null>(null);
  const treeWidthRef = useRef(LIVE_TREE_WIDTH_PX);
  const detailsWidthRef = useRef(0);
  const panesWidth = () => panesRef.current?.clientWidth ?? window.innerWidth;
  const tree = useDraggableWidth({
    storageKey: 'artisyn:liveTreeWidth',
    defaultWidth: LIVE_TREE_WIDTH_PX,
    minWidth: LIVE_TREE_MIN_WIDTH_PX,
    getMaxWidth: () =>
      panesWidth() - detailsWidthRef.current - LIVE_VIEW_MIN_WIDTH_PX,
  });
  const detailsPane = useDraggableWidth({
    storageKey: 'artisyn:liveDetailsWidth',
    defaultWidth: LIVE_DETAILS_WIDTH_PX,
    minWidth: LIVE_DETAILS_MIN_WIDTH_PX,
    rightPanel: true,
    getMaxWidth: () =>
      panesWidth() - treeWidthRef.current - LIVE_VIEW_MIN_WIDTH_PX,
  });
  treeWidthRef.current = tree.width;
  detailsWidthRef.current = panelKey !== null ? detailsPane.width : 0;

  const poll = useCallback<OtelPollStep<LivePollState>>(
    async (_prev, signal) => {
      const reqNode = nodeRef.current;
      const reqPanel = panelRef.current;
      const res = await fetchOtelLive(
        { node: reqNode, panel: reqPanel, tz },
        signal,
      );
      return {
        state: { res, node: reqNode, panel: reqPanel },
        newKeys: EMPTY_OTEL_NEW_KEYS,
        filled: NO_OTEL_FILLED,
      };
    },
    [tz],
  );

  const { state, error, isLoading, paused, setPaused, lastUpdatedAt, refresh } =
    useOtelLivePoll<LivePollState>({
      resetKey: 'live',
      enabled: true,
      intervalMs: OTEL_SESSION_POLL_MS,
      poll,
      isLive: () => true,
      refreshAbortsInFlight: true,
    });

  // A selection or panel change polls at once; the first render is the reset snapshot.
  const requestedRef = useRef({ node, panelKey });
  useEffect(() => {
    const prev = requestedRef.current;
    if (prev.node === node && prev.panelKey === panelKey) return;
    requestedRef.current = { node, panelKey };
    refresh();
  }, [node, panelKey, refresh]);

  // The server answers with the canonical key (or 'home' for a key it cannot show, DD-3):
  // replace the URL with it. Only for an answer to the key the URL still shows.
  const res = state?.res ?? null;
  useEffect(() => {
    if (state === null || liveKey === null) return;
    if (state.node === liveKey && state.res.selected !== liveKey) {
      select(state.res.selected);
    }
  }, [state, liveKey, select]);

  const onPause = useCallback(
    (next: boolean) => {
      setPausedAt(next ? Date.now() : null);
      setPaused(next);
    },
    [setPaused],
  );

  const home = res?.nodes.find((n) => n.type === 'home') ?? null;
  // Details only from an answer requested for the open panel key (a stale one would show the
  // previous node's figures); the node from the tree, the breakdown or the session's agents.
  const panelDetails =
    state !== null && panelKey !== null && state.panel === panelKey
      ? state.res.details
      : null;
  const panelNode = findPanelNode(res, panelKey, panelDetails);

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="w-[90vw] h-[90vh] max-w-none p-0 gap-0 flex flex-col overflow-hidden"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="live-modal"
      >
        <LiveModalHeader
          lastUpdatedAt={lastUpdatedAt}
          liveSessions={home?.totals.liveSessions ?? null}
          liveAgents={home?.totals.liveAgents ?? null}
          paused={paused}
          pausedAt={pausedAt}
          onPause={onPause}
          onClose={close}
        />
        {error !== null && res !== null && lastUpdatedAt !== null && (
          <div
            className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-sm text-amber-900"
            data-testid="live-error-banner"
            role="status"
          >
            Connection lost — showing data from{' '}
            {formatLiveClock(lastUpdatedAt, Date.now())}, retrying
          </div>
        )}
        <div className="flex min-h-0 flex-1" ref={panesRef}>
          {/* Left pane: the node tree (LiveTree). */}
          <div
            className="shrink-0 overflow-y-auto p-2 text-sm"
            style={{ width: tree.width }}
            data-testid="live-tree-pane"
          >
            {res !== null && (
              <LiveTree
                nodes={res.nodes}
                selected={res.selected}
                onSelect={select}
                onOpenPanel={setPanelKey}
              />
            )}
          </div>
          <LiveSplitter
            label="Resize the tree"
            testId="live-tree-splitter"
            onMouseDown={tree.onMouseDown}
          />
          {/* Middle pane: the selected node's view (LiveViewPane). */}
          <div
            className="min-w-0 flex-1 overflow-y-auto p-4"
            data-testid="live-view-pane"
          >
            {res !== null && (
              <LiveViewPane
                res={res}
                onSelect={select}
                onOpenPanel={setPanelKey}
              />
            )}
            {res === null && isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {res === null && !isLoading && error !== null && (
              <p className="text-sm text-destructive" data-testid="live-error">
                Could not load the live view.{' '}
                <button type="button" className="underline" onClick={refresh}>
                  Retry
                </button>
              </p>
            )}
          </div>
          {/* Right pane: details of panelKey (LiveDetailsPanel), only while open. */}
          {panelKey !== null && (
            <LiveSplitter
              label="Resize the details panel"
              testId="live-details-splitter"
              onMouseDown={detailsPane.onMouseDown}
            />
          )}
          {panelKey !== null && (
            <div
              className="shrink-0 overflow-y-auto p-3 text-sm"
              style={{ width: detailsPane.width }}
              data-testid="live-details-pane"
            >
              <LiveDetailsPanel
                node={panelNode}
                details={panelDetails}
                now={
                  res !== null
                    ? Date.parse(res.generatedAt) || Date.now()
                    : Date.now()
                }
                onClose={() => setPanelKey(null)}
                onOpenPanel={setPanelKey}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
