export interface HelpArticle {
  slug: string;
  title: string;
  /** Shows a "Download .md" button; the file is saved as `artisyn-log-hub-<slug>.md`. */
  downloadable?: boolean;
}

export interface HelpSection {
  section: string;
  articles: HelpArticle[];
}

export const helpNav: HelpSection[] = [
  {
    section: 'Getting Started',
    articles: [
      { slug: 'getting-started', title: 'Getting Started' },
      { slug: 'data-collection-notice', title: 'Data Collection Notice' },
    ],
  },
  {
    section: 'Reference',
    articles: [
      {
        slug: 'connect-repository',
        title: 'Connecting a Repository',
        downloadable: true,
      },
      { slug: 'session-list', title: 'Working with the Session List' },
      { slug: 'session-log', title: 'Session Log' },
      { slug: 'analytics-reports', title: 'Analytics & Reports' },
      { slug: 'cost-and-context', title: 'Understanding Cost & Context' },
      { slug: 'tuning-your-setup', title: 'Tuning Your Setup' },
      { slug: 'data-collection', title: 'Data Collection & Upload' },
    ],
  },
  {
    section: 'Technical Info',
    articles: [
      {
        slug: 'component-reference',
        title: 'Component Reference',
        downloadable: true,
      },
      {
        slug: 'security-hardening',
        title: 'Security Hardening & Configuration',
        downloadable: true,
      },
      {
        slug: 'responsibility-matrix',
        title: 'Responsibility Matrix (RACI)',
        downloadable: true,
      },
      {
        slug: 'third-party-components',
        title: 'Third-Party Components',
        downloadable: true,
      },
    ],
  },
  {
    section: 'Changelog',
    articles: [{ slug: 'changelog', title: 'Changelog' }],
  },
];

export function helpDownloadFileName(slug: string): string {
  return `artisyn-log-hub-${slug}.md`;
}
