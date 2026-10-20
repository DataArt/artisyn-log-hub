import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  deleteApiKey,
  fetchApiKeys,
  updateApiKey,
} from '../../api';
import { Button } from '../../ui/button';
import { DatePickerPopover } from '../../ui/date-picker-popover';
import { API_KEYS_TABS, type ApiKeysTab } from '../../tab-ids';
import { PageTabs, PageTabsContent } from '../../ui/page-tabs';
import { InstallTab } from './InstallTab';

const TAB_LABELS: Record<ApiKeysTab, string> = {
  install: 'Install',
  keys: 'API Keys',
};

const TABS = API_KEYS_TABS.map((t) => ({ value: t, label: TAB_LABELS[t] }));

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ApiKeysTab>('install');
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: keys = [], isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
  });

  const create = useMutation({
    mutationFn: () =>
      createApiKey(newKeyName.trim(), newKeyExpiry || undefined),
    onSuccess: (key) => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setRevealed(key);
      setNewKeyName('');
      setNewKeyExpiry('');
      setError('');
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    },
  });

  const patchExpiry = useMutation({
    mutationFn: ({
      id,
      expires_at,
    }: {
      id: number;
      expires_at: string | null;
    }) => updateApiKey(id, { expires_at }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to update expiry');
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteApiKey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  async function copyKey(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatDate(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageTabs
        tabs={TABS}
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as ApiKeysTab)}
        className="flex flex-col h-full"
        testIdGroup="apikeys"
      >
        <PageTabsContent value="install" className="flex-1 overflow-y-auto">
          <InstallTab />
        </PageTabsContent>

        <PageTabsContent value="keys" className="flex-1 overflow-y-auto">
          <div className="flex flex-col p-6 gap-6">
            {/* Revealed key banner */}
            {revealed && (
              <div className="p-4 border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 rounded-md flex flex-col gap-2">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Save this key — it won't be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-background border border-border rounded px-2 py-1.5 truncate">
                    {revealed.key}
                  </code>
                  <button
                    className="shrink-0 px-2 py-1.5 text-xs rounded border border-border hover:bg-accent transition-colors"
                    onClick={() => copyKey(revealed.key)}
                  >
                    {copied ? 'Copied!' : <Copy className="size-3.5" />}
                  </button>
                </div>
                <button
                  className="self-end text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setRevealed(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Create form */}
            <form
              className="flex items-end gap-2 p-4 border border-border rounded-md bg-card"
              onSubmit={(e) => {
                e.preventDefault();
                if (newKeyName.trim()) create.mutate();
              }}
            >
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Key name
                </label>
                <input
                  className="border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="e.g. CI pipeline"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1 w-44">
                <label className="text-xs font-medium text-muted-foreground">
                  Expires (optional)
                </label>
                <input
                  type="date"
                  className="border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  value={newKeyExpiry}
                  onChange={(e) =>
                    setNewKeyExpiry(
                      e.target.value ? `${e.target.value}T00:00:00Z` : '',
                    )
                  }
                />
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={create.isPending || !newKeyName.trim()}
              >
                Generate
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </form>

            {/* Keys table */}
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">No API keys yet.</p>
            ) : (
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                        Name
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                        Prefix
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                        Created
                      </th>
                      <th className="text-left px-4 py-2.5 font-medium text-xs uppercase tracking-wide text-muted-foreground">
                        Expires
                      </th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k: ApiKey, i) => (
                      <tr
                        key={k.id}
                        className={`border-b border-border last:border-0 group ${
                          i % 2 === 0 ? '' : 'bg-muted/20'
                        }`}
                      >
                        <td className="px-4 py-2.5 font-medium">{k.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          {k.slug}…
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {formatDate(k.created_at)}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <span>{formatDate(k.expires_at)}</span>
                            <DatePickerPopover
                              value={
                                k.expires_at ? new Date(k.expires_at) : null
                              }
                              onChange={(date) => {
                                patchExpiry.mutate({
                                  id: k.id,
                                  expires_at: date ? date.toISOString() : null,
                                });
                              }}
                            >
                              <button
                                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
                                title="Edit expiry"
                              >
                                <Pencil className="size-3" />
                              </button>
                            </DatePickerPopover>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title="Revoke"
                            onClick={() => {
                              if (confirm(`Revoke key "${k.name}"?`)) {
                                remove.mutate(k.id);
                              }
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </PageTabsContent>
      </PageTabs>
    </div>
  );
}
