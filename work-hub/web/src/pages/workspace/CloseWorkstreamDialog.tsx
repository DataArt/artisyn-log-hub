// "Close workstream" (FR-29, D10, Visual/UX "Close dialog"): `close/check` first; a busy agent
// asks for confirmation, then the three options. "Bring into main" also saves (commits) the files
// the agent left unsaved; only "Already merged elsewhere", which would lose them, lists them
// ("Back to chat" / "Close anyway"). A separate red "Discard…" has its own confirmation. No git terms are shown
// except the working-branch name.

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError, errorMessage } from "../../api/client";
import { workspaceKeys } from "../../api/workspaces";
import {
  closeCheck,
  closeWorkstream,
  discardWorkstream,
  type CloseMode,
  type CloseResult,
  type PushRemote,
  type PushResult,
  type WorkstreamSummary,
} from "../../api/workstreams";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import styles from "./CloseWorkstreamDialog.module.css";
import { PushOption } from "./PushOption";
import { PushResultView } from "./PushResultView";

export type CloseOutcome = CloseMode | "discard";

export interface CloseWorkstreamDialogProps {
  open: boolean;
  stream: WorkstreamSummary;
  onClose: () => void;
  /** The workstream was closed or discarded. */
  onDone: (outcome: CloseOutcome, stream: WorkstreamSummary) => void;
}

type Phase =
  | { kind: "checking" }
  | { kind: "busy"; uncommitted: string[] }
  | { kind: "uncommitted"; paths: string[]; mode: CloseMode | null }
  | { kind: "options" }
  | { kind: "working"; mode: CloseMode }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string; mode: CloseMode | null }
  | { kind: "discardConfirm" }
  | { kind: "discarding" }
  | { kind: "pushed"; mode: CloseMode; result: CloseResult; push: PushResult };

function UncommittedList({ paths }: { paths: string[] }) {
  return (
    <ul className={styles.uncommittedList} data-testid="close-uncommitted-list">
      {paths.map((p) => (
        <li key={p} className={styles.truncate} title={p}>
          {p}
        </li>
      ))}
    </ul>
  );
}

/** "3 files are not saved yet: a, b, c and 2 more." — above the options. */
function UnsavedNotice({ paths, base }: { paths: string[]; base: string }) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 3);
  const more = paths.length - shown.length;
  return (
    <div className={styles.unsavedNotice} data-testid="close-unsaved">
      <p className={styles.text}>
        {paths.length === 1
          ? "1 file is not saved (committed) yet:"
          : `${paths.length} files are not saved (committed) yet:`}
      </p>
      <ul className={styles.uncommittedList}>
        {shown.map((p) => (
          <li key={p} className={styles.truncate} title={p}>
            {p}
          </li>
        ))}
        {more > 0 && <li className={styles.mutedText}>and {more} more</li>}
      </ul>
      <p className={styles.mutedText}>
        "Bring into {base}" saves them too, so nothing is lost.
      </p>
    </div>
  );
}

function OptionButton({
  title,
  description,
  primary,
  onClick,
  onAim,
  testId,
}: {
  title: string;
  description: string;
  primary?: boolean;
  onClick: () => void;
  /** Hover / focus enters (`true`) or leaves (`false`) the option. */
  onAim: (aimed: boolean) => void;
  testId: string;
}) {
  return (
    <Button
      variant={primary ? "default" : "outline"}
      className={styles.option}
      onClick={onClick}
      onMouseEnter={() => onAim(true)}
      onMouseLeave={() => onAim(false)}
      onFocus={() => onAim(true)}
      onBlur={() => onAim(false)}
      data-testid={testId}
    >
      <span>{title}</span>
      <span
        className={
          primary ? styles.optionDescriptionPrimary : styles.optionDescription
        }
      >
        {description}
      </span>
    </Button>
  );
}

export function CloseWorkstreamDialog({
  open,
  stream,
  onClose,
  onDone,
}: CloseWorkstreamDialogProps) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  /** Files the agent left unsaved, from the last check (shown with the options). */
  const [unsaved, setUnsaved] = useState<string[]>([]);
  /** The remote a close can push to (D12), from the last check. */
  const [pushRemote, setPushRemote] = useState<PushRemote | null>(null);
  /** "Push to <remote>" is checked (unchecked on every opening). */
  const [push, setPush] = useState(false);
  /** The way to close the pointer or focus is on; the push option names its branch, or is
   *  disabled for "Already merged elsewhere". Null = none, which reads as "Bring into main". */
  const [aim, setAim] = useState<CloseMode | null>(null);
  /** The workstream's own branch from the last check; null from an older server. */
  const [streamBranch, setStreamBranch] = useState<string | null>(null);
  const aimAt = (mode: CloseMode) => (aimed: boolean) =>
    setAim((cur) => (aimed ? mode : cur === mode ? null : cur));
  /** "Close anyway" was chosen for the listed files. */
  const forceRef = useRef(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  };

  const runCheck = useCallback(async () => {
    forceRef.current = false;
    setPhase({ kind: "checking" });
    try {
      const check = await closeCheck(stream.id);
      setUnsaved(check.uncommitted);
      // An older server sends no `pushRemote`: no push option then.
      setPushRemote(check.pushRemote ?? null);
      setStreamBranch(check.branch ?? null);
      setPush(false);
      // Unsaved files do not stop the close: "Bring into main" takes them along (owner,
      // 2026-11-14); only "Already merged elsewhere", which deletes them, lists them (409).
      if (check.agentBusy) {
        setPhase({ kind: "busy", uncommitted: check.uncommitted });
      } else {
        setPhase({ kind: "options" });
      }
    } catch (err) {
      setPhase({ kind: "failed", message: errorMessage(err), mode: null });
    }
  }, [stream.id]);

  // Every opening starts with a fresh check.
  useEffect(() => {
    if (open) void runCheck();
  }, [open, runCheck]);

  const close = async (mode: CloseMode, commit = false) => {
    setPhase({ kind: "working", mode });
    const wantPush = push && pushRemote !== null && mode !== "merged_elsewhere";
    try {
      const result = await closeWorkstream(
        stream.id,
        mode,
        forceRef.current,
        commit,
        wantPush,
      );
      refresh();
      if (wantPush && result.push) {
        // Show what the push did before leaving; the workstream is closed either way.
        setPhase({ kind: "pushed", mode, result, push: result.push });
        return;
      }
      onDone(mode, result);
    } catch (err) {
      if (err instanceof ApiError && err.code === "uncommitted") {
        // Files appeared since the check: list them again, then send the same choice.
        setPhase({ kind: "uncommitted", paths: err.paths, mode });
        return;
      }
      if (err instanceof ApiError && err.code === "merge_conflict") {
        refresh();
        setPhase({ kind: "conflict", message: errorMessage(err) });
        return;
      }
      setPhase({ kind: "failed", message: errorMessage(err), mode });
    }
  };

  const discard = async () => {
    setPhase({ kind: "discarding" });
    try {
      const result = await discardWorkstream(stream.id);
      refresh();
      onDone("discard", result);
    } catch (err) {
      setPhase({ kind: "failed", message: errorMessage(err), mode: null });
    }
  };

  const closeAnyway = (mode: CloseMode | null) => {
    forceRef.current = true;
    if (mode) void close(mode);
    else setPhase({ kind: "options" });
  };

  const locked =
    phase.kind === "checking" ||
    phase.kind === "working" ||
    phase.kind === "discarding";

  const backToChat = (
    <Button
      variant="outline"
      onClick={onClose}
      data-testid="close-back-to-chat"
    >
      Back to chat
    </Button>
  );

  const spinner = (text: string, testId: string) => (
    <div className={styles.spinnerRow} data-testid={testId}>
      <Loader2 className={styles.spinnerIcon} />
      {text}
    </div>
  );

  let body: ReactNode;
  switch (phase.kind) {
    case "checking":
      body = spinner("Checking the workstream…", "close-checking");
      break;
    case "busy":
      body = (
        <>
          <p className={styles.text} data-testid="close-busy">
            The agent is still working in this chat. Close the workstream
            anyway?
          </p>
          <DialogFooter>
            {backToChat}
            <Button
              onClick={() => setPhase({ kind: "options" })}
              data-testid="close-busy-continue"
            >
              Continue
            </Button>
          </DialogFooter>
        </>
      );
      break;
    case "uncommitted":
      body = (
        <>
          <p className={styles.text}>
            These changed files are not in {stream.baseBranch} and will be lost:
          </p>
          <UncommittedList paths={phase.paths} />
          <p className={styles.mutedText}>
            To keep them, go back and choose "Bring into {stream.baseBranch}".
          </p>
          <DialogFooter>
            {backToChat}
            <Button
              variant="destructive"
              onClick={() => closeAnyway(phase.mode)}
              data-testid="close-anyway"
            >
              Close anyway
            </Button>
          </DialogFooter>
        </>
      );
      break;
    case "options":
      body = (
        <>
          <UnsavedNotice paths={unsaved} base={stream.baseBranch} />
          <PushOption
            pushRemote={pushRemote}
            branch={
              aim === "for_now"
                ? (streamBranch ?? "the workstream's branch")
                : stream.baseBranch
            }
            checked={push}
            onChange={setPush}
            disabled={aim === "merged_elsewhere"}
          />
          <div className={styles.options}>
            <OptionButton
              primary
              title="Bring into main"
              description={`Add all of this work to ${stream.baseBranch}, files the agent has not saved included, and close the workstream.`}
              onClick={() => void close("bring_into_main", true)}
              onAim={aimAt("bring_into_main")}
              testId="close-bring-into-main"
            />
            <OptionButton
              title="Already merged elsewhere"
              description="This work already reached its destination. Close the workstream and free its space."
              onClick={() => void close("merged_elsewhere")}
              onAim={aimAt("merged_elsewhere")}
              testId="close-merged-elsewhere"
            />
            <OptionButton
              title="Close for now"
              description="Stop the workstream. You can reopen it from History."
              onClick={() => void close("for_now")}
              onAim={aimAt("for_now")}
              testId="close-for-now"
            />
          </div>
          <DialogFooter className={styles.optionsFooter}>
            <Button
              variant="ghost"
              className={styles.discardButton}
              onClick={() => setPhase({ kind: "discardConfirm" })}
              data-testid="close-discard"
            >
              <Trash2 />
              Discard…
            </Button>
            {backToChat}
          </DialogFooter>
        </>
      );
      break;
    case "working":
      body = spinner(
        phase.mode === "bring_into_main"
          ? "Bringing your work into main…"
          : "Closing the workstream…",
        "close-working",
      );
      break;
    case "conflict":
      body = (
        <>
          <div
            role="alert"
            className={styles.conflict}
            data-testid="close-conflict"
          >
            <TriangleAlert className={styles.conflictIcon} />
            <span>{phase.message}</span>
          </div>
          <DialogFooter>
            <Button onClick={onClose} data-testid="close-back-to-chat">
              Back to chat
            </Button>
          </DialogFooter>
        </>
      );
      break;
    case "failed": {
      const retryMode = phase.mode;
      body = (
        <>
          <p
            className={styles.errorText}
            role="alert"
            data-testid="close-error"
          >
            {phase.message}
          </p>
          <DialogFooter>
            {backToChat}
            <Button
              onClick={() => void (retryMode ? close(retryMode) : runCheck())}
            >
              Try again
            </Button>
          </DialogFooter>
        </>
      );
      break;
    }
    case "discardConfirm":
      body = (
        <>
          <p className={styles.text} data-testid="close-discard-confirm">
            Discard {stream.name}? Its files and its work are removed and
            nothing is added to {stream.baseBranch}. This cannot be undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPhase({ kind: "options" })}
              data-testid="close-discard-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void discard()}
              data-testid="close-discard-confirm-button"
            >
              Discard
            </Button>
          </DialogFooter>
        </>
      );
      break;
    case "discarding":
      body = spinner("Discarding the workstream…", "close-discarding");
      break;
    case "pushed": {
      const { mode, result } = phase;
      body = (
        <>
          <PushResultView result={phase.push} />
          <DialogFooter>
            <Button
              onClick={() => onDone(mode, result)}
              data-testid="close-push-done"
            >
              Done
            </Button>
          </DialogFooter>
        </>
      );
      break;
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o || locked) return;
        // After a push the workstream is already closed: leaving is "done", not "cancel".
        if (phase.kind === "pushed") onDone(phase.mode, phase.result);
        else onClose();
      }}
    >
      <DialogContent
        showCloseButton={!locked}
        onInteractOutside={(e) => {
          if (locked) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (locked) e.preventDefault();
        }}
        data-testid="close-workstream-dialog"
        data-phase={phase.kind}
      >
        <DialogHeader>
          <DialogTitle>
            {phase.kind === "discardConfirm"
              ? "Discard workstream"
              : phase.kind === "pushed"
                ? `Closed ${stream.name}`
                : `Close ${stream.name}`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose what happens to the work of {stream.name}.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
