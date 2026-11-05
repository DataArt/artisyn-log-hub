/**
 * Barrel for the lazily loaded repository tabs: one `import()` specifier, so Rollup emits them as a
 * single chunk instead of one chunk per tab (Code splitting in
 * `docs/knowledgebase/client-routing-and-layout.md`). `RepoToolsTab` is also the session
 * Tools/MCP tab (`session-lazy-tabs.ts`), which loads it through this barrel too.
 *
 * `ReportsPanel` is deliberately not here: it carries the PDF and zip export libraries (~1.4 MB),
 * so it keeps its own `import()` and these light tabs never download them.
 */
export { RepositoryAnalytics } from './analytics/RepositoryAnalytics';
export { RepoToolsTab } from './tools/RepoToolsTab';
export { RepoOkfTab } from './okf/RepoOkfTab';
export { RepoOtelTab } from './otel/RepoOtelTab';
// The Live view modal shares this chunk: it carries Recharts and the OTEL tab code it reuses
// (2026-11-04 otel-live-view, DD-17).
export { LiveModal } from '../../live/LiveModal';
