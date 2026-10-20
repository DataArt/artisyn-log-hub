import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { CopyButton } from './CopyButton';

export function UpgradeHooksCard({ upgradeCmd }: { upgradeCmd: string }) {
  const { copied: copiedUpgrade, copy: copyUpgrade } =
    useCopyToClipboard(upgradeCmd);

  return (
    <div className="border border-border rounded-md bg-card p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Upgrade Hooks</h3>
        <p className="text-sm text-muted-foreground">
          Already installed? Run this to update to the latest hook version
          without re-running full install.
        </p>
      </div>

      <div className="flex items-center gap-2 mt-1 max-w-2xl">
        <CopyButton copied={copiedUpgrade} copy={copyUpgrade} />
        <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-3 py-2 overflow-x-auto whitespace-nowrap">
          {upgradeCmd}
        </code>
      </div>
    </div>
  );
}
