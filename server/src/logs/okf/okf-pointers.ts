/**
 * OKF usage — pointers an article hands to the agent (impl-plan DD-8, DD-9 of
 * 2026-11-03-okf-view-kb-value).
 *
 * A pointer is a back-ticked repo path in the text of a KB read result. Pure: no DB, no filesystem.
 *
 * Rules (pinned by `docs/knowledgebase/algorithms/okf-access-extraction.md`):
 * - Spans: every `` `([^`\n]{1,512})` `` of the text.
 * - Normalise: trim; drop a span that starts with `http`, `-`, `$`, `<` or `@`, or contains a space;
 *   strip a trailing `:\d+(-\d+)?`, then a `#…` anchor, then a leading `./`; reduce a glob to its
 *   static prefix; drop a trailing `/`.
 * - Keep it only if it contains `/` or has an extension. An absolute path is resolved to a
 *   repo-relative one through `resolveRepoPath`; one that does not resolve is dropped.
 * - De-duplicated within one text, first occurrence order kept.
 * - New: the pointer string is not a substring of the node's earlier text.
 * - Partial: the result is an error, empty after trimming, or starts with `<persisted-output>`.
 */
import { resolveRepoPath } from '../change-surface/path-normalise';
import {
  globStaticPrefix,
  hasExtension,
  toAbsolute,
} from './okf-access-extractor';
import { OKF_POINTER_MAX_CHARS } from './okf-constants';

const SPAN_RE = new RegExp('`([^`\\n]{1,' + OKF_POINTER_MAX_CHARS + '})`', 'g');
const DROP_PREFIXES = ['http', '-', '$', '<', '@'];
const GLOB_CHARS = /[*?[\]{}]/;

/** One normalised pointer of a span, or null when the span is not a repo path. */
function normalisePointer(
  span: string,
  roots: readonly (string | null | undefined)[],
): string | null {
  let p = span.trim();
  if (p === '' || /\s/.test(p)) return null;
  if (DROP_PREFIXES.some((prefix) => p.startsWith(prefix))) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/:\d+(-\d+)?$/, '');
  const hash = p.indexOf('#');
  if (hash >= 0) p = p.slice(0, hash);
  while (p.startsWith('./')) p = p.slice(2);
  if (GLOB_CHARS.test(p)) p = globStaticPrefix(p);
  p = p.replace(/\/+$/, '');
  if (p === '' || p.startsWith('~')) return null;
  if (!p.includes('/') && !hasExtension(p)) return null;
  const abs = toAbsolute(p);
  if (abs !== null) {
    const rel = resolveRepoPath(abs, roots);
    if (rel === null || rel === '') return null;
    p = rel.replace(/\/+$/, '');
    if (p === '') return null;
  }
  return p;
}

/** DD-8: the de-duplicated repo-relative pointers named in back-ticks in `text`. */
export function extractPointers(
  text: string,
  roots: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SPAN_RE)) {
    const pointer = normalisePointer(m[1], roots);
    if (pointer === null || seen.has(pointer)) continue;
    seen.add(pointer);
    out.push(pointer);
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
