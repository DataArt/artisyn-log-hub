/**
 * Barrel for the lazily loaded session detail tabs: one `import()` specifier, so Rollup emits them
 * as a single chunk instead of one small chunk per tab (Code splitting in
 * `docs/knowledgebase/client-routing-and-layout.md`). The session Tools/MCP tab reuses the
 * repository barrel (`repository-tabs-lazy-group.ts`), not this one.
 */
export { SessionChartsTab } from './session-log/SessionChartsTab';
export { SessionChangeSurfaceTab } from './session-log/change-surface/SessionChangeSurfaceTab';
export { SessionHarnessUsageTab } from './session-log/harness-usage/SessionHarnessUsageTab';
export { SessionOkfTab } from './session-log/okf/SessionOkfTab';
export { SessionSysctxAnatomyTab } from './session-log/sysctx-anatomy/SessionSysctxAnatomyTab';
export { SessionOtelTab } from './session-log/otel/SessionOtelTab';
export { SessionBashTab } from './session-log/bash-tab/SessionBashTab';
export { SessionMapTab } from './session-log/session-map/SessionMapTab';
