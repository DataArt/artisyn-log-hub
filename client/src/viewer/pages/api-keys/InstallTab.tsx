import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createApiKey } from '../../api';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useIsNewUser } from '../../hooks/useNewUserNudge';
import { Button } from '../../ui/button';
import { CopyButton } from './CopyButton';
import { UpgradeHooksCard } from './UpgradeHooksCard';

export function InstallTab() {
  const queryClient = useQueryClient();
  const [installerVersion, setInstallerVersion] = useState<string>('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/static/installer-version.json')
      .then((r) => r.json())
      .then((data: { version: string }) => setInstallerVersion(data.version))
      .catch(() => {});
  }, []);

  const versionSuffix = installerVersion ? `?v=${installerVersion}` : '';
  const npxCmd = `npx "${window.location.origin}/static/artisyn-hooks-installer.tgz${versionSuffix}" install`;
  const upgradeCmd = `npx "${window.location.origin}/static/artisyn-hooks-installer.tgz${versionSuffix}" upgrade`;
  const apiKeySnippet = generatedKey
    ? `{ "apiKey": "${generatedKey}" }`
    : '{ "apiKey": "<key>" }';
  const serverUrlSnippet = `{ "serverUrl": "${window.location.origin}" }`;

  const { copied: copiedNpx, copy: copyNpx } = useCopyToClipboard(npxCmd);
  const { copied: copiedApiKey, copy: copyApiKey } =
    useCopyToClipboard(apiKeySnippet);
  const { copied: copiedApiServer, copy: copyApiServer } =
    useCopyToClipboard(serverUrlSnippet);

  const generateKey = useMutation({
    mutationFn: () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      return createApiKey(`adhoc-${ts}`);
    },
    onSuccess: (key) => {
      setGeneratedKey(key.key);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  // A brand-new user is nudged to this tab, so draw their eye to the
  // one-liner button for a moment before it settles into a normal button.
  const isNewUser = useIsNewUser();
  const [shimmer, setShimmer] = useState(false);

  useEffect(() => {
    if (!isNewUser) return;
    setShimmer(true);
    const timer = setTimeout(() => setShimmer(false), 3000);
    return () => clearTimeout(timer);
  }, [isNewUser]);

  // Full Auto Install state
  const [generatedAutoKey, setGeneratedAutoKey] = useState<string | null>(null);
  const serverUrl = window.location.origin;

  const autoOneLiner = generatedAutoKey
    ? `npx "${serverUrl}/static/artisyn-hooks-installer.tgz${versionSuffix}" install --server-url "${serverUrl}" --api-key "${generatedAutoKey}"`
    : '';
  const { copied: copiedAutoOneLiner, copy: copyAutoOneLiner } =
    useCopyToClipboard(autoOneLiner);

  const generateAutoKey = useMutation({
    mutationFn: () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      return createApiKey(`auto-${ts}`);
    },
    onSuccess: (key) => {
      setGeneratedAutoKey(key.key);
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Full Auto Install */}
      <div className="border border-border rounded-md bg-card p-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold">Full Auto Install</h3>
          <p className="text-sm text-muted-foreground">
            Generate a one-liner that installs and configures everything in one
            step. Less secure — your API key will be visible in terminal
            history.
          </p>
        </div>

        {/* Single "Give Me String" button */}
        <div>
          <Button
            variant="default"
            className={shimmer ? 'give-me-string-shimmer' : undefined}
            data-nudge={shimmer ? 'shimmer' : undefined}
            disabled={generateAutoKey.isPending}
            onClick={() => generateAutoKey.mutate()}
          >
            {generateAutoKey.isPending && (
              <Loader2 className="size-3.5 animate-spin mr-2" />
            )}
            Give Me String
          </Button>
        </div>

        {generateAutoKey.isError && (
          <p className="text-xs text-destructive">
            {generateAutoKey.error instanceof Error
              ? generateAutoKey.error.message
              : 'Failed to generate key'}
          </p>
        )}

        {/* One-liner output — full width */}
        {generatedAutoKey && (
          <>
            <div className="flex items-center gap-2">
              <CopyButton copied={copiedAutoOneLiner} copy={copyAutoOneLiner} />
              <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
                {autoOneLiner}
              </code>
            </div>
            <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              The API key is visible in this command. Anyone with access to your
              shell history or process list can see it.
            </p>
          </>
        )}
      </div>

      <div className="border border-border rounded-md bg-card p-6 flex flex-col gap-5">
        {/* Step 1 */}
        <div className="flex gap-4">
          <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            1
          </span>
          <div className="flex flex-col gap-1.5 pt-0.5 flex-1 min-w-0">
            <p className="text-sm font-medium">Run the installer</p>
            <p className="text-sm text-muted-foreground">
              Run this command in your project directory to install the
              telemetry hook:
            </p>
            <div className="flex items-center gap-2 mt-1 max-w-2xl">
              <CopyButton copied={copiedNpx} copy={copyNpx} />
              <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
                {npxCmd}
              </code>
            </div>
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Step 2 */}
        <div className="flex gap-4">
          <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            2
          </span>
          <div className="flex flex-col gap-1.5 pt-0.5 flex-1 min-w-0">
            <p className="text-sm font-medium">Configure the hook</p>
            <p className="text-sm text-muted-foreground">
              Add your API key to{' '}
              <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
                .artisyn/config/log-hub.local.json
              </code>
              :
            </p>
            <div className="flex items-center gap-2 mt-1 max-w-xl">
              <CopyButton copied={copiedApiKey} copy={copyApiKey} />
              <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
                {apiKeySnippet}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={generateKey.isPending}
                onClick={() => generateKey.mutate()}
              >
                {generateKey.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : generatedKey ? (
                  'Regenerate'
                ) : (
                  'Generate Key NOW'
                )}
              </Button>
            </div>
            {generateKey.isError && (
              <p className="text-xs text-destructive">
                {generateKey.error instanceof Error
                  ? generateKey.error.message
                  : 'Failed to generate key'}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Step 3 */}
        <div className="flex gap-4">
          <span className="shrink-0 inline-flex items-center justify-center size-7 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            3
          </span>
          <div className="flex flex-col gap-1.5 pt-0.5 flex-1 min-w-0">
            <p className="text-sm font-medium">Set the server URL</p>
            <p className="text-sm text-muted-foreground">
              Add the server URL to{' '}
              <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
                .artisyn/config/log-hub.json
              </code>
              :
            </p>
            <div className="flex items-center gap-2 mt-1 max-w-xl">
              <CopyButton copied={copiedApiServer} copy={copyApiServer} />
              <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
                {serverUrlSnippet}
              </code>
            </div>
          </div>
        </div>
      </div>

      <UpgradeHooksCard upgradeCmd={upgradeCmd} />
    </div>
  );
}
