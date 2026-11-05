/**
 * OKF action text (2026-11-03 OKF value signals, impl-plan DD-26 / FR-16): what to change in
 * the KB and where, one line per finding. Shared by the verdict card, the tree, the session tab
 * and the article drill-down; value-signal rows are passed in as findings with the same rule ids.
 *
 * The server sends rule ids + params only. Params used here: `file` (the article or file path;
 * the verdict rules carry it as `path` / `node.path`), `bundle`, `patterns` (comma-joined top
 * patterns), `area` (the common folder of the area files), `files` (count) and `path` (on
 * `dead_pointers`: the dead pointers, comma-joined). `session_share` has no action, and a rule id
 * this client does not know (a newer server) gets none either — `formatOkfFinding` still shows it.
 */
import type { OkfFinding } from '../../../models/repositories';

/** Appended to the action of a finding computed over sessions on an older article version. */
export const OKF_STALE_ACTION_SUFFIX =
  ' · re-check after sessions on the current version';

function str(v: string | number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** The article / file a finding is about: `file`, else the finding node's path, else `path`. */
function fileOf(finding: OkfFinding): string {
  const p = finding.params ?? {};
  return str(p.file) || finding.node?.path || str(p.path);
}

function baseAction(finding: OkfFinding): string | null {
  const p = finding.params ?? {};
  const file = fileOf(finding);
  switch (finding.rule) {
    case 'coarse_article':
      return `split ${file} at its headings or add section pointers to index.md`;
    case 'always_read':
      return `move the facts of ${file} into index.md / CLAUDE.md`;
    case 'kb_flood':
      return `the index lines of ${str(p.bundle) || (finding.node?.bundle ?? '')} do not route — agents read a quarter of the bundle; sharpen the one-line descriptions`;
    case 'searched_after':
      return `after reading ${file}, agents searched for ${str(p.patterns)} — add these facts to the article or a section pointer to them`;
    case 'routing_miss':
      return `agents searched ${str(p.area)} for ${str(p.patterns)} without opening ${file} — mention these in its index.md line (or in CLAUDE.md routing)`;
    case 'dead_pointers':
      return `remove ${str(p.path)} from ${file}, or write it as a full repo-relative path next to the fact it serves`;
    case 'catalog':
      return `${file} lists ${str(p.files)} code paths — check it against C3: paths that grep finds in seconds need not be listed; keep the non-obvious ones`;
    case 'session_share':
      return null;
    default:
      return null;
  }
}

/** The action line of a finding, or `null` when it has none (`session_share`, unknown rules). */
export function okfActionText(finding: OkfFinding): string | null {
  const action = baseAction(finding);
  if (action === null) return null;
  return finding.stale ? `${action}${OKF_STALE_ACTION_SUFFIX}` : action;
}
