import { LogField, AdditionalFields } from './primitives';

export function AiTitleExpanded({ entry }: { entry: Record<string, unknown> }) {
  const known = ['aiTitle', 'sessionId', 'type'];
  return (
    <div>
      <LogField label="AI Title">{String(entry.aiTitle ?? '—')}</LogField>
      <LogField label="Session ID">{String(entry.sessionId ?? '—')}</LogField>
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function FileHistorySnapshotExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const snapshot = entry.snapshot as Record<string, unknown> | undefined;
  const known = ['type', 'isSnapshotUpdate', 'messageId', 'snapshot'];

  // inline JsonBlock to avoid importing raw-logs-primitives JsonBlock here
  // actually we do import from raw-logs-primitives
  return (
    <div>
      <LogField label="Is snapshot update">
        {String(entry.isSnapshotUpdate ?? '—')}
      </LogField>
      <LogField label="Message ID">{String(entry.messageId ?? '—')}</LogField>
      {snapshot && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            snapshot
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 mt-1 max-h-60 overflow-auto">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function LastPromptExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const known = ['type', 'sessionId', 'leafUuid', 'lastPrompt'];
  return (
    <div>
      <LogField label="Session ID">{String(entry.sessionId ?? '—')}</LogField>
      <LogField label="Leaf UUID">{String(entry.leafUuid ?? '—')}</LogField>
      {entry.lastPrompt !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            lastPrompt
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2">
            {String(entry.lastPrompt)}
          </pre>
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function ModeExpanded({ entry }: { entry: Record<string, unknown> }) {
  const known = ['type', 'sessionId', 'mode'];
  return (
    <div>
      <LogField label="Mode">{String(entry.mode ?? '—')}</LogField>
      <LogField label="Session ID">{String(entry.sessionId ?? '—')}</LogField>
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function PermissionModeExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const known = ['type', 'sessionId', 'permissionMode'];
  return (
    <div>
      <LogField label="Permission mode">
        {String(entry.permissionMode ?? '—')}
      </LogField>
      <LogField label="Session ID">{String(entry.sessionId ?? '—')}</LogField>
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function QueueOperationExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const known = ['type', 'sessionId', 'timestamp', 'operation', 'content'];
  return (
    <div>
      <LogField label="Operation">{String(entry.operation ?? '—')}</LogField>
      <LogField label="Session ID">{String(entry.sessionId ?? '—')}</LogField>
      {entry.content !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            content
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2">
            {String(entry.content)}
          </pre>
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}
