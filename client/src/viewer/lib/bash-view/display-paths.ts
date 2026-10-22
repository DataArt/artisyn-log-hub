/**
 * Display-only path rule of the Bash view: the session's repo-root prefix is shown repo-relative.
 * Algorithm doc: `docs/knowledgebase/algorithms/bash-command-view.md`.
 *
 * The root matches in its own spelling, with `/` or `\` separators, and — for a drive root such as
 * `C:/work/app` — in the msys form `/c/work/app`, case-insensitively. `root/…` (or `root\…`) loses
 * the prefix; a bare `root` before the end, whitespace, a quote, `;`, `)` or `&` becomes `.`.
 * Copy actions always use the original text, never this.
 */

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootVariants(root: string): string[] {
  const fwd = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!fwd) return [];
  const variants = new Set([fwd, fwd.replace(/\//g, '\\')]);
  const drive = /^([A-Za-z]):\//.exec(fwd);
  if (drive) variants.add(`/${drive[1].toLowerCase()}${fwd.slice(2)}`);
  // Longest first, so the regex alternation never stops at a shorter spelling.
  return [...variants].sort((a, b) => b.length - a.length);
}

/** `text` with every occurrence of the repo root `root` made repo-relative. */
export function toRepoRelative(
  text: string,
  root: string | null | undefined,
): string {
  if (!root || !text) return text;
  const variants = rootVariants(root);
  if (!variants.length) return text;
  const re = new RegExp(
    `(?<![\\w.~-])(?:${variants.map(escapeRe).join('|')})(?:([\\\\/])|(?=$|[\\s'";)&]))`,
    'gi',
  );
  return text.replace(re, (_m, sep: string | undefined) => (sep ? '' : '.'));
}
