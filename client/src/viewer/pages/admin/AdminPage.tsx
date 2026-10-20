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
import {
  type AdminTab,
  ADMIN_TABS,
  useAdminTabState,
} from './useAdminTabState';

// Display list order must match ADMIN_TABS from useAdminTabState.ts.
const TABS: { value: AdminTab; label: string }[] = [
  { value: ADMIN_TABS[0], label: 'System Info' },
  { value: ADMIN_TABS[1], label: 'Repos' },
  { value: ADMIN_TABS[2], label: 'Teams' },
  { value: ADMIN_TABS[3], label: 'Users' },
  { value: ADMIN_TABS[4], label: 'Error Logs' },
  { value: ADMIN_TABS[5], label: 'Upload Queue' },
  { value: ADMIN_TABS[6], label: 'Data Retention' },
  { value: ADMIN_TABS[7], label: 'Auth' },
  { value: ADMIN_TABS[8], label: 'Model Pricing' },
];

export function AdminPage() {
  const { tab, setTab } = useAdminTabState();
  const { user } = useAuth();

  const isAdmin = user?.role === 'admin';
  // Every non-admin — team owner or not — sees only the Data Retention tab here;
  // its endpoint is independently guarded server-side (AdminOrTeamOwnerGuard), so a
  // non-owner who reaches this page directly gets a 403 error state, not extra access.
  const visibleTabs = isAdmin
    ? TABS
    : TABS.filter((t) => t.value === 'data-retention');

  const activeTab = visibleTabs.some((t) => t.value === tab)
    ? tab
    : visibleTabs[0].value;

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full overflow-hidden">
        <PageTabs
          tabs={visibleTabs}
          value={activeTab}
          onValueChange={(v) => setTab(v as AdminTab)}
          className="flex flex-col h-full"
          testIdGroup="admin"
        >
          {visibleTabs.some((t) => t.value === 'system-info') && (
            <PageTabsContent
              value="system-info"
              className="flex-1 overflow-y-auto"
            >
              <AdminSystemTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'all-repos') && (
            <PageTabsContent
              value="all-repos"
              className="flex-1 overflow-y-auto"
            >
              <AdminReposTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'all-teams') && (
            <PageTabsContent
              value="all-teams"
              className="flex-1 overflow-y-auto"
            >
              <AdminTeamsTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'all-users') && (
            <PageTabsContent
              value="all-users"
              className="flex-1 overflow-y-auto"
            >
              <AdminUsersTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'error-logs') && (
            <PageTabsContent
              value="error-logs"
              className="flex-1 overflow-y-auto"
            >
              <AdminErrorLogsTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'upload-queue') && (
            <PageTabsContent
              value="upload-queue"
              className="flex-1 overflow-y-auto"
            >
              <AdminUploadQueueTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'data-retention') && (
            <PageTabsContent
              value="data-retention"
              className="flex-1 overflow-y-auto"
            >
              <AdminDataRetentionTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'auth') && (
            <PageTabsContent value="auth" className="flex-1 overflow-y-auto">
              <AdminAuthTab />
            </PageTabsContent>
          )}
          {visibleTabs.some((t) => t.value === 'model-pricing') && (
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
