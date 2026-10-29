/**
 * Classifies a link inside a help article (DD-14). The help generator has
 * already rewritten every link between help pages to `<slug>.md[#anchor]`, so
 * the app only needs to recognise that form.
 */
export type HelpHref =
  | { kind: 'external' }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'page'; slug: string; anchor?: string }
  | { kind: 'unknown' };

const EXTERNAL_RE = /^(https?:|mailto:)/i;
const PAGE_RE = /^(?:\.\/)?([A-Za-z0-9_-]+)\.md(?:#(.*))?$/;

export function parseHelpHref(
  href: string,
  knownSlugs: ReadonlySet<string>,
): HelpHref {
  if (EXTERNAL_RE.test(href)) return { kind: 'external' };
  if (href.startsWith('#')) return { kind: 'anchor', anchor: href.slice(1) };
  const match = PAGE_RE.exec(href);
  if (match && knownSlugs.has(match[1])) {
    const anchor = match[2];
    return anchor
      ? { kind: 'page', slug: match[1], anchor }
      : { kind: 'page', slug: match[1] };
  }
  return { kind: 'unknown' };
}
