/**
 * Opens a map leaf's target (DD-10, DD-19): a `route` target navigates with its search and
 * router state (a session chart is a plain session tab, so it is a route target too), a `help`
 * target opens the in-app help on that article. A leaf without a target (missing context, data-gated) does nothing here.
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NavNode, NavTarget } from './nav-tree';

function withSearch(path: string, search?: Record<string, string>): string {
  if (!search) return path;
  const qs = new URLSearchParams(search).toString();
  return qs ? `${path}?${qs}` : path;
}

export interface MapActivation {
  activate: (node: NavNode) => void;
  openTarget: (target: NavTarget) => void;
  /** The help article to show, or `null` while the help is closed. */
  helpSlug: string | null;
  closeHelp: () => void;
}

export function useMapActivate(): MapActivation {
  const navigate = useNavigate();
  const [helpSlug, setHelpSlug] = useState<string | null>(null);

  const openTarget = useCallback(
    (target: NavTarget) => {
      switch (target.kind) {
        case 'route':
          void navigate(withSearch(target.path, target.search), {
            state: target.state,
          });
          return;
        case 'help':
          setHelpSlug(target.slug);
          return;
      }
    },
    [navigate],
  );

  const activate = useCallback(
    (node: NavNode) => {
      if (node.target) openTarget(node.target);
    },
    [openTarget],
  );

  const closeHelp = useCallback(() => setHelpSlug(null), []);

  return { activate, openTarget, helpSlug, closeHelp };
}
