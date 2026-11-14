// The tab row (Visual/UX): pinned tabs first (chat, Login, Configure) with no close control,
// then the file tabs. A dirty file tab shows a dot.

import { FileText, KeyRound, MessageSquare, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import type { PinnedKind, Tab, TabsStore } from "./tabs-store";
import styles from "./TabBar.module.css";
import { baseName } from "./tree-model";

const PINNED_ICON: Record<PinnedKind, ReactNode> = {
  chat: <MessageSquare className={styles.iconSm} />,
  login: <KeyRound className={styles.iconSm} />,
  configure: <Wrench className={styles.iconSm} />,
};

export interface TabBarProps {
  store: TabsStore;
  /** Asks to close a file tab (the page confirms a dirty one first). */
  onRequestClose: (tabId: string) => void;
  /** Shown at the right end of the row (e.g. "Close workstream"). */
  actions?: ReactNode;
}

function TabButton({
  tab,
  active,
  onFocus,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onFocus: () => void;
  onClose?: () => void;
}) {
  const isFile = tab.kind === "file";
  const label = isFile ? baseName(tab.path) : tab.title;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={isFile ? tab.path : tab.title}
      data-testid={isFile ? "file-tab" : `pinned-tab-${tab.kind}`}
      data-path={isFile ? tab.path : undefined}
      data-dirty={isFile && tab.dirty ? "true" : undefined}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
      className={cn(
        styles.tab,
        active ? styles.tabActive : styles.tabInactive,
        !isFile && styles.tabPinned,
      )}
    >
      {isFile ? (
        <FileText className={styles.fileIcon} />
      ) : (
        PINNED_ICON[tab.kind]
      )}
      <span className={styles.label}>{label}</span>
      {isFile && tab.dirty && (
        <span
          className={styles.dirtyDot}
          aria-label="Unsaved changes"
          data-testid="tab-dirty"
        />
      )}
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          data-testid="tab-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            styles.close,
            isFile && tab.dirty
              ? styles.closeDirty
              : active
                ? styles.closeVisible
                : styles.closeOnHover,
          )}
        >
          <X className={styles.iconSm} />
        </button>
      )}
    </div>
  );
}

export function TabBar({ store, onRequestClose, actions }: TabBarProps) {
  const { state } = store;
  return (
    <div className={styles.bar}>
      <div role="tablist" aria-label="Open tabs" className={styles.tablist}>
        {state.pinned.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={state.activeId === tab.id}
            onFocus={() => store.focus(tab.id)}
          />
        ))}
        {state.files.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={state.activeId === tab.id}
            onFocus={() => store.focus(tab.id)}
            onClose={() => onRequestClose(tab.id)}
          />
        ))}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
