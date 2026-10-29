// Types for links.js (CommonJS) — see docs/knowledgebase/algorithms/user-docs-links.md.

/** One entry of a nav.json section. */
export interface NavArticle {
  slug: string;
  title: string;
  downloadable?: boolean;
  /** Source path relative to `user-docs/` (e.g. `../hook/INSTALL_HOOK.md`); default `<slug>.md`. */
  source?: string;
}

/** One section of `user-docs/nav.json`. */
export interface NavSection {
  section: string;
  articles: NavArticle[];
}

/** A page of the set with its resolved source file. */
export interface NavPage {
  slug: string;
  title: string;
  downloadable: boolean;
  section: string;
  /** Absolute source path. */
  file: string;
}

export interface Nav {
  sections: NavSection[];
  pages: NavPage[];
}

/** What `resolveLink` needs: only the page list. */
export interface NavPages {
  pages: Pick<NavPage, 'slug' | 'file'>[];
}

export type LinkResolution =
  | { kind: 'external' }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'page'; slug: string; anchor: string | null }
  | { kind: 'unresolved' };

export function loadNav(repoRoot: string): Nav;
export function resolveLink(href: string, fromFile: string, nav: NavPages): LinkResolution;
export function findLinks(markdown: string): string[];
export function rewritePageLinks(markdown: string, fromFile: string, nav: NavPages): string;
