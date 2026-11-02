import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { TooltipProvider } from '../../ui/tooltip';
import { useAuth } from '../../context/AuthContext';
import { AdminReposTab } from './tabs/AdminReposTab';
import { AdminTeamsTab } from './tabs/AdminTeamsTab';
import { AdminUsersTab } from './tabs/AdminUsersTab';
import { AdminSystemTab } from './tabs/AdminSystemTab';
import { AdminErrorLogsTab } from './tabs/AdminErrorLogsTab';
import { AdminUploadQueueTab } from './tabs/AdminUploadQueueTab';
import { AdminDataRetentionTab } from './tabs/AdminDataRetentionTab';
import { AdminAuthTab } from './tabs/AdminAuthTab';
import { AdminModelPricingTab } from './tabs/AdminModelPricingTab';
import { visibleTabs } from '../../tab-ids';
import { type AdminTab, useAdminTabState } from './useAdminTabState';

export function AdminPage() {
  const { tab, setTab } = useAdminTabState();
  const { user } = useAuth();

  const isAdmin = user?.role === 'admin';
  // Every non-admin — team owner or not — sees only the Data Retention tab here (the one admin
  // row without an `isAdmin` predicate in the tab registry); its endpoint is independently
  // guarded server-side (AdminOrTeamOwnerGuard), so a non-owner who reaches this page directly
  // gets a 403 error state, not extra access.
  const shownTabs = visibleTabs('admin', { isAdmin }).map((r) => ({
    value: r.id,
    label: r.label,
    description: r.description,
  }));

  const activeTab = shownTabs.some((t) => t.value === tab)
    ? tab
    : shownTabs[0].value;

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full overflow-hidden">
        <PageTabs
          tabs={shownTabs}
          value={activeTab}
          onValueChange={(v) => setTab(v as AdminTab)}
          className="flex flex-col h-full"
          testIdGroup="admin"
        >
          {shownTabs.some((t) => t.value === 'system-info') && (
            <PageTabsContent
              value="system-info"
              className="flex-1 overflow-y-auto"
            >
              <AdminSystemTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'all-repos') && (
            <PageTabsContent
              value="all-repos"
              className="flex-1 overflow-y-auto"
            >
              <AdminReposTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'all-teams') && (
            <PageTabsContent
              value="all-teams"
              className="flex-1 overflow-y-auto"
            >
              <AdminTeamsTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'all-users') && (
            <PageTabsContent
              value="all-users"
              className="flex-1 overflow-y-auto"
            >
              <AdminUsersTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'error-logs') && (
            <PageTabsContent
              value="error-logs"
              className="flex-1 overflow-y-auto"
            >
              <AdminErrorLogsTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'upload-queue') && (
            <PageTabsContent
              value="upload-queue"
              className="flex-1 overflow-y-auto"
            >
              <AdminUploadQueueTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'data-retention') && (
            <PageTabsContent
              value="data-retention"
              className="flex-1 overflow-y-auto"
            >
              <AdminDataRetentionTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'auth') && (
            <PageTabsContent value="auth" className="flex-1 overflow-y-auto">
              <AdminAuthTab />
            </PageTabsContent>
          )}
          {shownTabs.some((t) => t.value === 'model-pricing') && (
            <PageTabsContent
              value="model-pricing"
              className="flex-1 overflow-y-auto"
            >
              <AdminModelPricingTab />
            </PageTabsContent>
          )}
        </PageTabs>
      </div>
    </TooltipProvider>
  );
}
