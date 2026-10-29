import nav from '@loghub/user-docs/nav.json';

export interface HelpArticle {
  slug: string;
  title: string;
  /** Shows a "Download .md" button; the file is saved as `artisyn-log-hub-<slug>.md`. */
  downloadable?: boolean;
  /**
   * Source file relative to `user-docs/` when the page does not live at
   * `user-docs/<slug>.md` (e.g. `../hook/INSTALL_HOOK.md`). The help generator
   * resolves it; the app always fetches `/help/<slug>.md`.
   */
  source?: string;
}

export interface HelpSection {
  section: string;
  articles: HelpArticle[];
}

/** The help menu — sections and pages come from `user-docs/nav.json`. */
export const helpNav: HelpSection[] = nav;

export function helpDownloadFileName(slug: string): string {
  return `artisyn-log-hub-${slug}.md`;
}
