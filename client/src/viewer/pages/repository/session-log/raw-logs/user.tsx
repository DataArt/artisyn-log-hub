import type * as React from 'react';
import {
  LogField,
  JsonBlock,
  CopyButton,
  AdditionalFields,
  COMMON_KEYS,
  CommonFields,
} from './primitives';

export function ToolResultBlock({ block }: { block: Record<string, unknown> }) {
  const id = String(block.tool_use_id ?? '');
  const isError = block.is_error === true;
  const content = block.content;

  let contentEl: React.ReactNode = null;
  if (typeof content === 'string') {
    contentEl = (
      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-60 overflow-auto mt-1">
        {content}
      </pre>
    );
  } else if (Array.isArray(content)) {
    contentEl = (
      <div className="space-y-1 mt-1">
        {(content as Record<string, unknown>[]).map((sub, i) =>
          sub.type === 'text' ? (
            <pre
              key={i}
              className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto"
            >
              {String(sub.text ?? '')}
            </pre>
          ) : (
            <JsonBlock key={i} value={sub} />
          ),
        )}
      </div>
    );
  } else if (content !== undefined) {
    contentEl = <JsonBlock value={content} />;
  }

  return (
    <div className="border border-border/60 rounded px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${isError ? 'bg-destructive/20 text-destructive' : 'bg-muted/60 text-muted-foreground'}`}
        >
          {isError ? 'error' : 'ok'}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground break-all">
          {id}
        </span>
      </div>
      {contentEl}
    </div>
  );
}

export function UserPromptText({ text }: { text: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs text-muted-foreground font-semibold">
          prompt
        </span>
        <CopyButton text={text} />
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-96 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

export function UserMessageContent({ content }: { content: unknown }) {
  if (Array.isArray(content)) {
    const blocks = content as Record<string, unknown>[];
    return (
      <div className="space-y-1.5">
        {blocks.map((block, i) => {
          if (block.type === 'text') {
            return <UserPromptText key={i} text={String(block.text ?? '')} />;
          }
          if (block.type === 'tool_result') {
            return <ToolResultBlock key={i} block={block} />;
          }
          return (
            <div key={i}>
              <div className="text-xs text-muted-foreground font-semibold mb-0.5">
                {String(block.type ?? 'block')}
              </div>
              <JsonBlock value={block} />
            </div>
          );
        })}
      </div>
    );
  }

  if (typeof content === 'string') {
    return <UserPromptText text={content} />;
  }

  return <JsonBlock value={content} />;
}

export function UserExpanded({ entry }: { entry: Record<string, unknown> }) {
  const msg = entry.message as Record<string, unknown> | undefined;
  const known = [
    ...COMMON_KEYS,
    'message',
    'content',
    'cost',
    'tokens',
    'promptId',
    'isMeta',
    'isCompactSummary',
    'isVisibleInTranscriptOnly',
    'interruptedMessageId',
    'permissionMode',
    'promptSource',
    'sourceToolAssistantUUID',
    'sourceToolUseID',
    'toolUseResult',
    'origin',
    'mcpMeta',
  ];
  return (
    <div>
      <CommonFields entry={entry} />
      {entry.promptId !== undefined && (
        <LogField label="Prompt ID">{String(entry.promptId)}</LogField>
      )}
      {entry.isMeta !== undefined && (
        <LogField label="Is meta">{String(entry.isMeta)}</LogField>
      )}
      {entry.isCompactSummary !== undefined && (
        <LogField label="Is compact summary">
          {String(entry.isCompactSummary)}
        </LogField>
      )}
      {entry.isVisibleInTranscriptOnly !== undefined && (
        <LogField label="Visible in transcript only">
          {String(entry.isVisibleInTranscriptOnly)}
        </LogField>
      )}
      {entry.interruptedMessageId !== undefined && (
        <LogField label="Interrupted message ID">
          {String(entry.interruptedMessageId)}
        </LogField>
      )}
      {entry.permissionMode !== undefined && (
        <LogField label="Permission mode">
          {String(entry.permissionMode)}
        </LogField>
      )}
      {entry.promptSource !== undefined && (
        <LogField label="Prompt source">{String(entry.promptSource)}</LogField>
      )}
      {entry.sourceToolAssistantUUID !== undefined && (
        <LogField label="Source tool assistant UUID">
          {String(entry.sourceToolAssistantUUID)}
        </LogField>
      )}
      {entry.sourceToolUseID !== undefined && (
        <LogField label="Source tool use ID">
          {String(entry.sourceToolUseID)}
        </LogField>
      )}
      {/* compact entries: no message object, content at top level */}
      {!msg && typeof entry.content === 'string' && (
        <div className="mt-2">
          <UserPromptText text={entry.content} />
          {entry.cost !== undefined && (
            <LogField label="Cost">{`$${String(entry.cost)}`}</LogField>
          )}
          {entry.tokens !== undefined && (
            <LogField label="Tokens">{String(entry.tokens)}</LogField>
          )}
        </div>
      )}
      {/* message object */}
      {msg?.content !== undefined && (
        <div className="mt-2">
          <UserMessageContent content={msg.content} />
        </div>
      )}
      {entry.toolUseResult !== undefined && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            toolUseResult
          </div>
          <JsonBlock value={entry.toolUseResult} />
        </div>
      )}
      {entry.origin !== undefined &&
        (() => {
          const o = entry.origin as Record<string, unknown>;
          return (
            <LogField label="Origin">
              {String(o.kind ?? JSON.stringify(o))}
            </LogField>
          );
        })()}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}
