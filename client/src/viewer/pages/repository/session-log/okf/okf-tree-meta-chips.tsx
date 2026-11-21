/**
 * OKF v0.3 front-matter chips of the OKF tree and the agent trail. Format hints are advice and
 * use the sky (info) palette; content warnings (`deprecated`, past `stale_after`) are amber. Old-hook
 * data carries none of these fields, so nothing renders for it.
 */
import type {
  OkfBundleSummary,
  OkfTreeNode,
} from '../../../../../models/repositories';
import { OKF_HINT_LABELS, okfBaseName } from './okf-tree';

/** Sky (info) chip — format hints, never a warning. */
export const OKF_HINT_CHIP =
  'shrink-0 rounded border border-sky-300 px-1 text-[10px] text-sky-700 dark:border-sky-700 dark:text-sky-300';
/** Amber chip — content warnings (deprecated, past stale_after). */
export const OKF_WARN_CHIP =
  'shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-900/50 dark:text-amber-200';

/** Bundle row: "ⓘ newer format (0.3)" and "ⓘ N can improve". */
export function OkfBundleHintChips({ info }: { info?: OkfBundleSummary }) {
  if (!info) return null;
  const improve = info.articlesWithHints ?? 0;
  const reasons = (info.hintReasons ?? []).map((r) => OKF_HINT_LABELS[r]);
  return (
    <>
      {info.newerFormatHint ? (
        <span
          data-testid="okf-tree-bundle-newer-format"
          className={OKF_HINT_CHIP}
          title="Advice — this KB folder still works as is."
        >
          ⓘ newer format (0.3)
        </span>
      ) : null}
      {improve > 0 ? (
        <span
          data-testid="okf-tree-bundle-can-improve"
          className={OKF_HINT_CHIP}
          title={reasons.join(', ') || undefined}
        >
          ⓘ {improve.toLocaleString()} can improve
        </span>
      ) : null}
    </>
  );
}

/** "deprecated" chip plus "→ name" of the replacement (a link when it can be opened). */
export function OkfDeprecatedChips({
  supersededBy,
  onOpen,
}: {
  supersededBy?: string;
  /** Set when the replacement article can be opened. */
  onOpen?: (path: string) => void;
}) {
  return (
    <>
      <span data-testid="okf-deprecated-chip" className={OKF_WARN_CHIP}>
        deprecated
      </span>
      {supersededBy ? (
        onOpen ? (
          <button
            type="button"
            data-testid="okf-superseded-by"
            onClick={() => onOpen(supersededBy)}
            title={supersededBy}
            className="max-w-40 shrink-0 truncate text-[10px] text-amber-900 hover:underline dark:text-amber-200"
          >
            → {okfBaseName(supersededBy)}
          </button>
        ) : (
          <span
            data-testid="okf-superseded-by"
            title={supersededBy}
            className="max-w-40 shrink-0 truncate text-[10px] text-amber-900 dark:text-amber-200"
          >
            → {okfBaseName(supersededBy)}
          </span>
        )
      ) : null}
    </>
  );
}

/** File row: deprecated / → replacement / past stale_after / ⓘ can improve. */
export function OkfFileMetaChips({
  node,
  isKnownFile,
  onOpenArticle,
}: {
  node: OkfTreeNode;
  isKnownFile?: (path: string) => boolean;
  onOpenArticle?: (path: string) => void;
}) {
  const hints = node.formatHints ?? [];
  const canOpen =
    node.supersededBy !== undefined &&
    onOpenArticle !== undefined &&
    (isKnownFile?.(node.supersededBy) ?? false);
  return (
    <>
      {node.deprecated ? (
        <OkfDeprecatedChips
          supersededBy={node.supersededBy}
          onOpen={canOpen ? onOpenArticle : undefined}
        />
      ) : null}
      {node.pastStaleAfter ? (
        <span data-testid="okf-past-stale-after" className={OKF_WARN_CHIP}>
          past stale_after
        </span>
      ) : null}
      {hints.length > 0 ? (
        <span
          data-testid="okf-can-improve"
          className={OKF_HINT_CHIP}
          title={hints.map((h) => OKF_HINT_LABELS[h]).join(', ')}
        >
          ⓘ can improve
        </span>
      ) : null}
    </>
  );
}
