// `#/w/:wsId` and `#/w/:wsId/s/:streamId` — the workspace IDE (FR-13–FR-21, D12): the switcher
// row, the file tree on the left and the tabs on the right. On the working-branch view the view is
// `main`; on a workstream it is the workstream id (FR-18) and its chat is the pinned first tab.
// Login and Configure run as pinned service tabs; a workspace with no agent login shows the amber
// login banner.

import { useQuery } from "@tanstack/react-query";
import {
  History,
  KeyRound,
  Loader2,
  LogOut,
  Settings,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { errorMessage } from "../../api/client";
import { MAIN_VIEW, type PollResult } from "../../api/fs";
import { getWorkspace, workspaceKeys } from "../../api/workspaces";
import { chatSocketPath } from "../../api/workstreams";
import { FileTabContent } from "../../ide/FileTabContent";
import { FileTree } from "../../ide/FileTree";
import { TabBar } from "../../ide/TabBar";
import { useTabs, type FileTab, type PinnedTab } from "../../ide/tabs-store";
import { polledDirs, useFileTree } from "../../ide/tree-model";
import { useFsPoll } from "../../ide/useFsPoll";
import { TopBar } from "../../layout/TopBar";
import { cn } from "../../lib/cn";
import { routes } from "../../routes";
import { TerminalView } from "../../terminal/TerminalView";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { useToast } from "../../ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { AgentLoginDialog } from "./AgentLoginDialog";
import {
  CloseWorkstreamDialog,
  type CloseOutcome,
} from "./CloseWorkstreamDialog";
import { ConfigureTab } from "./ConfigureTab";
import { LoginTab } from "./LoginTab";
import { WorkstreamNotice } from "./WorkstreamNotice";
import { WorkstreamSwitcher } from "./WorkstreamSwitcher";
import styles from "./WorkspacePage.module.css";

const LOGIN_TAB: PinnedTab = { kind: "login", id: "login", title: "Login" };
const CONFIGURE_TAB: PinnedTab = {
  kind: "configure",
  id: "configure",
  title: "Configure",
};

/** The toast after a close, in plain words (no git terms but the working branch). */
function closedText(outcome: CloseOutcome, name: string, base: string) {
  switch (outcome) {
    case "bring_into_main":
      return `${name} was brought into ${base}.`;
    case "merged_elsewhere":
      return `${name} is done.`;
    case "for_now":
      return `${name} is closed. You can reopen it from History.`;
    case "discard":
      return `${name} was discarded.`;
  }
}

export function WorkspacePage() {
  const { wsId = "", streamId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const view = streamId ?? MAIN_VIEW;

  const query = useQuery({
    queryKey: workspaceKeys.detail(wsId),
    queryFn: () => getWorkspace(wsId),
    enabled: wsId !== "",
  });
  const workspace = query.data;
  const stream =
    streamId === undefined
      ? undefined
      : workspace?.workstreams.find((s) => s.id === streamId);
  /** The tree and the tabs can talk to the view: `main`, or an open, available workstream. */
  const viewReady =
    workspace !== undefined &&
    (streamId === undefined || (stream !== undefined && stream.available));

  const tree = useFileTree(wsId, view);
  const tabs = useTabs();
  const [diskVersions, setDiskVersions] = useState<PollResult["files"]>({});
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<FileTab | null>(null);

  // A different workspace or view starts with a fresh tree and no tabs.
  const { loadRoot } = tree;
  const { reset: resetTabs } = tabs;
  const viewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${wsId}\u0000${view}`;
    if (viewKeyRef.current !== null && viewKeyRef.current !== key) {
      resetTabs();
      setDiskVersions({});
      setCloseDialogOpen(false);
    }
    viewKeyRef.current = key;
  }, [wsId, view, resetTabs]);

  useEffect(() => {
    if (wsId !== "" && viewReady) void loadRoot();
  }, [wsId, view, viewReady, loadRoot]);

  // The workstream's chat is the pinned first tab, in front when the view opens (AC-14).
  const { pin } = tabs;
  const streamName = stream?.name;
  useEffect(() => {
    if (streamName === undefined) return;
    pin({ kind: "chat", id: "chat", title: `Chat · ${streamName}` }, false);
  }, [view, streamName, pin]);

  // A configuration still running (another tab, a reload) reopens its service tab once.
  const configureReopenedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace?.configureActive) return;
    if (configureReopenedRef.current === workspace.id) return;
    configureReopenedRef.current = workspace.id;
    pin(CONFIGURE_TAB, false);
  }, [workspace?.configureActive, workspace?.id, pin]);

  // ---- poll ------------------------------------------------------------------------------------

  const dirs = useMemo(() => polledDirs(tree.state), [tree.state]);
  const files = useMemo(
    () => tabs.state.files.map((t) => t.path),
    [tabs.state.files],
  );
  const poll = useFsPoll({
    workspaceId: wsId,
    view,
    dirs,
    files,
    onDirs: tree.mergeListings,
    onFiles: setDiskVersions,
    enabled: wsId !== "" && viewReady,
  });

  // ---- tabs ------------------------------------------------------------------------------------

  const anyDirty = tabs.state.files.some((t) => t.dirty);
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  const requestClose = useCallback(
    (tabId: string) => {
      const tab = tabs.state.files.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.dirty) setCloseConfirm(tab);
      else tabs.close(tabId);
    },
    [tabs],
  );

  const openFile = useCallback(
    (path: string) => {
      tree.select(path);
      tabs.openFile(path);
    },
    [tree, tabs],
  );

  const onStreamClosed = (outcome: CloseOutcome) => {
    setCloseDialogOpen(false);
    if (stream) {
      toast.show(
        closedText(outcome, stream.name, stream.baseBranch),
        "success",
      );
    }
    void navigate(routes.workspace(wsId));
  };

  const activeFile = tabs.active?.kind === "file" ? tabs.active.path : null;
  const hasLoginTab = tabs.state.pinned.some((t) => t.id === "login");
  const showLoginBanner =
    workspace !== undefined &&
    workspace.loginState === "missing" &&
    !hasLoginTab;

  // ---- render ----------------------------------------------------------------------------------

  const crumb = workspace?.name ?? (query.isPending ? "…" : "Workspace");

  return (
    <div className={styles.page}>
      <TopBar
        crumb={crumb}
        history={
          <Button asChild variant="ghost" size="sm">
            <Link to={routes.history(wsId)} data-testid="topbar-history">
              <History />
              History
            </Link>
          </Button>
        }
        settings={
          <Button asChild variant="ghost" size="sm">
            <Link to={routes.settings(wsId)} data-testid="topbar-settings">
              <Settings />
              Settings
            </Link>
          </Button>
        }
        configure={
          // The wrench belongs to the working-branch view only (Visual/UX).
          streamId === undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Configure"
                  disabled={workspace === undefined}
                  onClick={() => tabs.pin(CONFIGURE_TAB)}
                  data-testid="topbar-configure"
                >
                  <Wrench />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Configure the container</TooltipContent>
            </Tooltip>
          )
        }
      />

      {query.isPending && (
        <div className={styles.loading}>
          <Loader2 className={styles.spinner} />
        </div>
      )}

      {query.isError && (
        <div className={styles.error}>
          <p className={styles.errorText}>{errorMessage(query.error)}</p>
          <div className={styles.errorActions}>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
            <Button asChild variant="ghost">
              <Link to={routes.workspaces}>All workspaces</Link>
            </Button>
          </div>
        </div>
      )}

      {workspace && (
        <>
          {showLoginBanner && (
            <div
              role="status"
              data-testid="login-banner"
              className={styles.loginBanner}
            >
              <KeyRound className={styles.loginBannerIcon} />
              <span className={styles.loginBannerText}>
                This workspace needs a {workspace.agentName} login.
              </span>
              <Button
                size="sm"
                onClick={() => setLoginDialogOpen(true)}
                data-testid="login-banner-button"
              >
                Log in
              </Button>
            </div>
          )}

          <WorkstreamSwitcher
            workspace={workspace}
            activeStreamId={streamId ?? null}
          />

          {!viewReady ? (
            <WorkstreamNotice
              workspaceId={wsId}
              stream={stream}
              refetching={query.isFetching}
            />
          ) : (
            <div className={styles.ide}>
              <aside className={styles.sidebar}>
                <div className={styles.sidebarHeader}>Files</div>
                <div className={styles.sidebarTree}>
                  <FileTree
                    workspaceId={wsId}
                    view={view}
                    model={tree}
                    activePath={activeFile}
                    onOpenFile={openFile}
                    onMoved={tabs.moved}
                    onLocalChange={poll.invalidate}
                    rootLabel={stream?.name ?? workspace.name}
                  />
                </div>
              </aside>

              <section className={styles.tabsArea}>
                <TabBar
                  store={tabs}
                  onRequestClose={requestClose}
                  actions={
                    stream && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setCloseDialogOpen(true)}
                        data-testid="close-workstream"
                      >
                        <LogOut />
                        Close workstream
                      </Button>
                    )
                  }
                />
                <div className={styles.tabPanels}>
                  {tabs.state.pinned.map((tab) => (
                    <div
                      key={tab.id}
                      className={cn(
                        styles.tabPanel,
                        tabs.state.activeId !== tab.id && styles.hidden,
                      )}
                    >
                      {tab.kind === "chat" && stream && (
                        <TerminalView
                          key={stream.id}
                          wsPath={chatSocketPath(stream.id)}
                          replayFrom={stream.id}
                        />
                      )}
                      {tab.kind === "login" && (
                        <LoginTab
                          workspaceId={wsId}
                          agentName={workspace.agentName}
                          onClose={() => tabs.unpin("login")}
                        />
                      )}
                      {tab.kind === "configure" && (
                        <ConfigureTab
                          workspaceId={wsId}
                          onClose={() => tabs.unpin("configure")}
                        />
                      )}
                    </div>
                  ))}
                  {tabs.state.files.map((tab) => (
                    <div
                      key={tab.id}
                      className={cn(
                        styles.tabPanel,
                        tabs.state.activeId !== tab.id && styles.hidden,
                      )}
                    >
                      <FileTabContent
                        workspaceId={wsId}
                        view={view}
                        path={tab.path}
                        diskVersion={diskVersions[tab.path]}
                        onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                        onLocalChange={poll.invalidate}
                        onCloseTab={() => tabs.close(tab.id)}
                      />
                    </div>
                  ))}
                  {tabs.active === null && (
                    <div className={styles.noTab} data-testid="no-tab">
                      Open a file from the tree to view or edit it.
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          <AgentLoginDialog
            open={loginDialogOpen}
            workspaceId={wsId}
            agentName={workspace.agentName}
            onClose={() => setLoginDialogOpen(false)}
            onLoginStarted={() => tabs.pin(LOGIN_TAB)}
          />

          {stream && (
            <CloseWorkstreamDialog
              open={closeDialogOpen}
              stream={stream}
              onClose={() => setCloseDialogOpen(false)}
              onDone={onStreamClosed}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={closeConfirm !== null}
        header="Close without saving?"
        message={`Your changes to ${closeConfirm?.path ?? "this file"} will be lost.`}
        confirmLabel="Close without saving"
        destructive
        onConfirm={() => {
          if (closeConfirm) tabs.close(closeConfirm.id);
          setCloseConfirm(null);
        }}
        onCancel={() => setCloseConfirm(null)}
      />
    </div>
  );
}
