/**
 * help-nav.ts — the help/user-docs page set as the tests see it (impl-plan DD-8).
 *
 * The client reads `user-docs/nav.json` through the `@loghub/user-docs` alias, which
 * `tests/tsconfig.json` cannot resolve, so the tests never import `help/articles/index.ts`.
 * They read the nav with the same pure link module the help generator and the site renderer use
 * (`scripts/user-docs/links.js`, typed by `links.d.ts`).
 */
import * as path from 'path';
import { findLinks, loadNav, resolveLink } from '../../../scripts/user-docs/links';
import type { NavPage, NavSection } from '../../../scripts/user-docs/links';

export { findLinks, loadNav, resolveLink };
export type { NavPage, NavSection };

/** Repository root (absolute). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const nav = loadNav(REPO_ROOT);

/** The nav sections, in menu order — same shape as the client's `helpNav`. */
export const helpNav: readonly NavSection[] = nav.sections;

/** Every page of the set, in menu order, with its absolute source file. */
export const helpPages: NavPage[] = nav.pages;

/** Repo-relative source path of a page (`/` separators), e.g. `hook/INSTALL_HOOK.md`. */
export function helpPageFile(slug: string): string {
  const page = nav.pages.find((p) => p.slug === slug);
  if (!page) throw new Error(`unknown help page: ${slug}`);
  return path.relative(REPO_ROOT, page.file).split(path.sep).join('/');
}
