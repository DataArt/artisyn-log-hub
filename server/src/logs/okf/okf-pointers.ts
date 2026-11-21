/**
 * OKF usage — pointers an article hands to the agent (impl-plan DD-8, DD-9 of
 * 2026-11-03-okf-view-kb-value; DD-P2, DD-P3 of 2026-11-19-okf-v03-support).
 *
 * A pointer is a back-ticked repo path in the text of a KB read result. Pure: no DB, no filesystem.
 *
 * Rules (pinned by `docs/knowledgebase/algorithms/okf-access-extraction.md`):
 * - Spans: every `` `([^`\n]{1,512})` `` of the text.
 * - Normalise: trim; drop a span that starts with `http`, `-`, `$`, `<` or `@`, or contains a space,
 *   `(` or `)`; backslashes become `/`; strip a trailing `:\d+(-\d+)?`, then a `#…` anchor; reduce
 *   a glob to its static prefix; drop a trailing `/`. A leading `./` / `../` is kept (OKF v0.3 §6).
 * - Drop a bare version / number (`2.31.0`, `v1.2`). Keep a span with `/` (a leading `./` does not
 *   count); keep one without `/` only when its extension is in `OKF_POINTER_FILE_EXTENSIONS`
 *   (`README.md` yes, `process.env`, `Logger.error` no; a dotfile such as `.env` has no extension).
 * - Kind of a span: `dot` (starts with `./` or `../`), `absolute` (drive letter `X:/`), `rooted`
 *   (starts with `/`), `bare` (anything else). De-duplicated on the normalised text, first
 *   occurrence order kept.
 * - Candidates (repo-relative, `.` / `..` collapsed, an escape above the repo root dropped):
 *   `dot` → the article's folder joined with the text; `absolute` → `resolveRepoPath`; `rooted` →
 *   `resolveRepoPath` when it resolves inside the session repo, else the article's bundle root
 *   joined with the rest; `bare` → article folder + p, repo + p, bundle root + p (in that order,
 *   de-duplicated). A span with no candidate is dropped.
 * - New: the span text is not a substring of the node's earlier text.
 * - Partial: the result is an error, empty after trimming, or starts with `<persisted-output>`.
 */
import {
  collapseRepoRelative,
  resolveRepoPath,
} from '../change-surface/path-normalise';
import { globStaticPrefix } from './okf-access-extractor';
import {
  OKF_POINTER_FILE_EXTENSIONS,
  OKF_POINTER_MAX_CHARS,
} from './okf-constants';

const SPAN_RE = new RegExp('`([^`\\n]{1,' + OKF_POINTER_MAX_CHARS + '})`', 'g');
const DROP_PREFIXES = ['http', '-', '$', '<', '@'];
const GLOB_CHARS = /[*?[\]{}]/;
const VERSION_RE = /^v?\d+(\.\d+)*$/;
const DRIVE_RE = /^[A-Za-z]:\//;

/** How a pointer span names its path (OKF v0.3 §6). */
export type OkfPointerKind = 'dot' | 'rooted' | 'bare' | 'absolute';

/** One normalised back-ticked path of a read result (DD-P2). */
export interface OkfPointerSpan {
  /** The span after the `:line`, `#anchor`, glob and trailing-`/` cuts, before resolution. */
  text: string;
  kind: OkfPointerKind;
  /** The part joined onto a base: `text` without the leading `/` for `rooted`, else `text`. */
  path: string;
}

/** Where a pointer of one article resolves from (DD-P3, DD-P4). */
export interface OkfPointerContext {
  /** Repo-relative folder of the article (`''` at the repo root). */
  articleDir: string;
  /** Repo-relative root folder of the article's bundle (`''` = repo root). */
  bundleRoot: string;
  /** The session's candidate repo roots. */
  roots: readonly (string | null | undefined)[];
}

/** A `/`-less name is a file pointer only with a known extension (a dotfile has none). */
function hasKnownExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return OKF_POINTER_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function kindOf(p: string): OkfPointerKind {
  if (p.startsWith('./') || p.startsWith('../')) return 'dot';
  if (DRIVE_RE.test(p)) return 'absolute';
  if (p.startsWith('/')) return 'rooted';
  return 'bare';
}

/** One normalised span, or null when the span is not a repo path. */
function normaliseSpan(span: string): OkfPointerSpan | null {
  let p = span.trim();
  if (p === '' || /[\s()]/.test(p)) return null;
  if (DROP_PREFIXES.some((prefix) => p.startsWith(prefix))) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/:\d+(-\d+)?$/, '');
  const hash = p.indexOf('#');
  if (hash >= 0) p = p.slice(0, hash);
  if (GLOB_CHARS.test(p)) p = globStaticPrefix(p);
  p = p.replace(/\/+$/, '');
  if (p === '' || p.startsWith('~')) return null;
  // The filters judge the path without its leading `./` (as before v0.3 support).
  let bare = p;
  while (bare.startsWith('./')) bare = bare.slice(2);
  if (bare === '' || bare === '.') return null;
  if (VERSION_RE.test(bare)) return null;
  if (!bare.includes('/') && !hasKnownExtension(bare)) return null;
  const kind = kindOf(p);
  return {
    text: p,
    kind,
    path: kind === 'rooted' ? p.replace(/^\/+/, '') : p,
  };
}

/** DD-P2: the de-duplicated pointer spans named in back-ticks in `text`. */
export function extractPointerSpans(text: string): OkfPointerSpan[] {
  const out: OkfPointerSpan[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SPAN_RE)) {
    const span = normaliseSpan(m[1]);
    if (span === null || seen.has(span.text)) continue;
    seen.add(span.text);
    out.push(span);
  }
  return out;
}

function join(base: string, rest: string): string {
  return base === '' ? rest : `${base}/${rest}`;
}

/** A repo path resolved from an absolute spelling, or null (outside the repo, or the root itself). */
function resolveAbsolute(
  p: string,
  roots: readonly (string | null | undefined)[],
): string | null {
  const rel = resolveRepoPath(p, roots);
  if (rel === null) return null;
  const trimmed = rel.replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * DD-P3: the repo-relative paths a span may name, most likely first; de-duplicated, without
 * escapes above the repo root and without the repo root itself. Empty → the span is dropped.
 */
export function pointerCandidates(
  span: OkfPointerSpan,
  ctx: OkfPointerContext,
): string[] {
  let raw: (string | null)[];
  switch (span.kind) {
    case 'dot':
      raw = [collapseRepoRelative(join(ctx.articleDir, span.path))];
      break;
    case 'absolute':
      raw = [resolveAbsolute(span.text, ctx.roots)];
      break;
    case 'rooted': {
      const abs = resolveAbsolute(span.text, ctx.roots);
      raw = [abs ?? collapseRepoRelative(join(ctx.bundleRoot, span.path))];
      break;
    }
    default:
      raw = [
        collapseRepoRelative(join(ctx.articleDir, span.path)),
        collapseRepoRelative(span.path),
        collapseRepoRelative(join(ctx.bundleRoot, span.path)),
      ];
  }
  const out: string[] = [];
  for (const c of raw) {
    if (c === null || c === '' || out.includes(c)) continue;
    out.push(c);
  }
  return out;
}

/** DD-9: a read result cut to a preview, empty or failed — its pointers do not count for yield. */
export function isPartialResult(text: string, isError: boolean): boolean {
  if (isError) return true;
  const body = text.trim();
  return body === '' || body.startsWith('<persisted-output>');
}

/** DD-9: a pointer is new when the node's earlier text does not already name it. */
export function isNewPointer(pointer: string, priorText: string): boolean {
  return !priorText.includes(pointer);
}
