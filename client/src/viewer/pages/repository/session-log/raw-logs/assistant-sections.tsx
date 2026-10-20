import { LogField } from './primitives';
import { UsageFields, ContentBlocks } from './assistant';

/** Error state block — shown when entry.isApiErrorMessage is truthy. */
export function AssistantErrorSection({
  apiErrorStatus,
  error,
  errorDetails,
}: {
  apiErrorStatus: unknown;
  error: unknown;
  errorDetails: unknown;
}) {
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground font-semibold mb-1">
        Error
      </div>
      <LogField label="Status">{String(apiErrorStatus ?? '—')}</LogField>
      <LogField label="Error">{String(error ?? '—')}</LogField>
      {errorDetails !== undefined && (
        <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 mt-1 max-h-32 overflow-auto">
          {String(errorDetails)}
        </pre>
      )}
    </div>
  );
}

/** Compact entry fallback — no message object, just raw content + cost/tokens. */
export function AssistantCompactContent({
  content,
  cost,
  tokens,
}: {
  content: unknown;
  cost?: unknown;
  tokens?: unknown;
}) {
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground font-semibold mb-1">
        content
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto">
        {String(content)}
      </pre>
      {cost !== undefined && (
        <LogField label="Cost">{`$${String(cost)}`}</LogField>
      )}
      {tokens !== undefined && (
        <LogField label="Tokens">{String(tokens)}</LogField>
      )}
    </div>
  );
}

/** Full message object section — ID, model, stop reason, usage, content blocks. */
export function AssistantMessageSection({
  msg,
}: {
  msg: Record<string, unknown>;
}) {
  const content = Array.isArray(msg.content)
    ? (msg.content as unknown[])
    : null;
  const usage = msg.usage as Record<string, unknown> | undefined;

  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground font-semibold mb-1">
        message
      </div>
      {msg.id !== undefined && <LogField label="ID">{String(msg.id)}</LogField>}
      {msg.model !== undefined && (
        <LogField label="Model">{String(msg.model)}</LogField>
      )}
      {msg.stop_reason !== undefined && msg.stop_reason !== null && (
        <LogField label="Stop reason">{String(msg.stop_reason)}</LogField>
      )}
      {msg.stop_sequence !== undefined && msg.stop_sequence !== null && (
        <LogField label="Stop sequence">{String(msg.stop_sequence)}</LogField>
      )}

      {usage && (
        <div className="mt-1.5">
          <div className="text-xs text-muted-foreground font-semibold mb-0.5">
            usage
          </div>
          <UsageFields usage={usage} />
        </div>
      )}

      {content && content.length > 0 && (
        <div className="mt-1.5">
          <div className="text-xs text-muted-foreground font-semibold mb-0.5">
            {`content (${content.length} block${content.length !== 1 ? 's' : ''})`}
          </div>
          <ContentBlocks content={content} />
        </div>
      )}
    </div>
  );
}
