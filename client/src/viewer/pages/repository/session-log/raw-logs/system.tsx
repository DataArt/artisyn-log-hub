import {
  LogField,
  JsonBlock,
  AdditionalFields,
  COMMON_KEYS,
  CommonFields,
} from './primitives';

export function SystemExpanded({ entry }: { entry: Record<string, unknown> }) {
  const known = [
    ...COMMON_KEYS,
    'subtype',
    'content',
    'isMeta',
    'level',
    'durationMs',
    'hasOutput',
    'hookAdditionalContext',
    'hookCount',
    'hookErrors',
    'hookInfos',
    'messageCount',
    'pendingBackgroundAgentCount',
    'preventedContinuation',
    'stopReason',
    'toolUseID',
    'logicalParentUuid',
    'compactMetadata',
  ];
  return (
    <div>
      <LogField label="Subtype">{String(entry.subtype ?? '—')}</LogField>
      <CommonFields entry={entry} />
      {entry.isMeta !== undefined && (
        <LogField label="Is meta">{String(entry.isMeta)}</LogField>
      )}
      {entry.level !== undefined && (
        <LogField label="Level">{String(entry.level)}</LogField>
      )}
      {entry.durationMs !== undefined && (
        <LogField label="Duration (ms)">{String(entry.durationMs)}</LogField>
      )}
      {entry.hasOutput !== undefined && (
        <LogField label="Has output">{String(entry.hasOutput)}</LogField>
      )}
      {entry.hookCount !== undefined && (
        <LogField label="Hook count">{String(entry.hookCount)}</LogField>
      )}
      {entry.messageCount !== undefined && (
        <LogField label="Message count">{String(entry.messageCount)}</LogField>
      )}
      {entry.preventedContinuation !== undefined && (
        <LogField label="Prevented continuation">
          {String(entry.preventedContinuation)}
        </LogField>
      )}
      {entry.stopReason !== undefined && (
        <LogField label="Stop reason">{String(entry.stopReason)}</LogField>
      )}
      {entry.toolUseID !== undefined && (
        <LogField label="Tool use ID">{String(entry.toolUseID)}</LogField>
      )}
      {entry.logicalParentUuid !== undefined && (
        <LogField label="Logical parent UUID">
          {String(entry.logicalParentUuid)}
        </LogField>
      )}
      {entry.pendingBackgroundAgentCount !== undefined && (
        <LogField label="Pending bg agents">
          {String(entry.pendingBackgroundAgentCount)}
        </LogField>
      )}
      {entry.content !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            content
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto">
            {String(entry.content)}
          </pre>
        </div>
      )}
      {entry.compactMetadata !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            compactMetadata
          </div>
          <JsonBlock value={entry.compactMetadata} />
        </div>
      )}
      {entry.hookAdditionalContext !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            hookAdditionalContext
          </div>
          <JsonBlock value={entry.hookAdditionalContext} />
        </div>
      )}
      {entry.hookErrors !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            hookErrors
          </div>
          <JsonBlock value={entry.hookErrors} />
        </div>
      )}
      {entry.hookInfos !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            hookInfos
          </div>
          <JsonBlock value={entry.hookInfos} />
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}

export function SystemContextExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const claudeMd = entry.claudeMd as Record<string, unknown> | undefined;
  const known = ['type', 'claudeMd'];
  return (
    <div>
      {claudeMd && (
        <div>
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            claudeMd
          </div>
          <LogField label="Total bytes">
            {String(claudeMd.totalBytes ?? '—')}
          </LogField>
          {claudeMd.files !== undefined && (
            <div className="mt-1">
              <LogField label="Files">
                <JsonBlock value={claudeMd.files} />
              </LogField>
            </div>
          )}
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}
