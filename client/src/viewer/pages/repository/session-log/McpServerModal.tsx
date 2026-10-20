import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import type { McpServerConfig } from './types';

interface Props {
  server: McpServerConfig;
  toolCount: number;
  estTokens: number;
  invocationCount: number;
  toolNames: string[];
  onClose: () => void;
}

export function McpServerModal({
  server,
  toolCount,
  estTokens,
  invocationCount,
  toolNames,
  onClose,
}: Props) {
  const shortToolNames = toolNames.map((t) =>
    t.startsWith(`mcp__${server.name}__`)
      ? t.slice(`mcp__${server.name}__`.length)
      : t,
  );

  // Reconstruct args array from the pre-joined string stored in session data
  const argsArray = server.args.trim()
    ? (server.args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    : [];
  const argsPreviewText =
    argsArray.slice(0, 3).join(' ') +
    (argsArray.length > 3 ? ` (+${argsArray.length - 3} more)` : '');
  const isUrlBased = !!server.url;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {server.name}
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="overview">
          <TabsList className="w-full">
            <TabsTrigger value="overview" className="flex-1">
              Overview
            </TabsTrigger>
            <TabsTrigger value="raw" className="flex-1">
              Raw Config
            </TabsTrigger>
            <TabsTrigger value="tools" className="flex-1">
              Tools
              {toolCount > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {toolCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 space-y-4">
            {/* Connection section */}
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Connection
              </p>
              <div className="rounded border border-border bg-muted/40 p-3 space-y-1.5">
                {isUrlBased ? (
                  <div className="flex gap-3 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      URL
                    </span>
                    <span className="font-mono text-foreground break-all">
                      {server.url}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-3 text-xs">
                      <span className="w-20 shrink-0 text-muted-foreground">
                        Command
                      </span>
                      <span className="font-mono text-foreground">
                        {server.command || (
                          <span className="text-muted-foreground italic">
                            —
                          </span>
                        )}
                      </span>
                    </div>
                    {argsArray.length > 0 && (
                      <div className="flex gap-3 text-xs">
                        <span className="w-20 shrink-0 text-muted-foreground">
                          Args
                        </span>
                        <span
                          className="font-mono text-foreground break-all"
                          title={server.args}
                        >
                          {argsPreviewText}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Config source */}
            <div className="rounded border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs dark:border-amber-700/50 dark:bg-amber-950/30">
              <span className="text-amber-700 dark:text-amber-400">
                Defined in{' '}
              </span>
              <span className="font-mono text-amber-800 dark:text-amber-300">
                {server.configSource === 'user'
                  ? '~/.claude/settings.json'
                  : '.mcp.json'}
              </span>
            </div>

            {/* Stats cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded border border-border bg-muted/30 p-3 text-center">
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {toolCount}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Tools active
                </p>
              </div>
              <div className="rounded border border-border bg-muted/30 p-3 text-center">
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  ~{estTokens.toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground">Est. tokens</p>
              </div>
              <div className="rounded border border-border bg-muted/30 p-3 text-center">
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {invocationCount}
                </p>
                <p className="text-[10px] text-muted-foreground">Invocations</p>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground">
              Credentials stripped from display.
            </p>
          </TabsContent>

          <TabsContent value="raw" className="mt-4">
            <pre className="rounded border border-border bg-muted/40 p-3 text-xs font-mono text-foreground overflow-auto max-h-64 whitespace-pre-wrap break-all">
              {JSON.stringify(
                isUrlBased
                  ? { url: server.url }
                  : { command: server.command, args: argsArray },
                null,
                2,
              )}
            </pre>
          </TabsContent>

          <TabsContent value="tools" className="mt-4">
            {shortToolNames.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No tools recorded for this session.
              </p>
            ) : (
              <ul className="space-y-1">
                {shortToolNames.map((name) => (
                  <li key={name} className="font-mono text-xs text-foreground">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
