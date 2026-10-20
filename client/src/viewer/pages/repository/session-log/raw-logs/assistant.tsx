import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  LogField,
  JsonBlock,
  AdditionalFields,
  COMMON_KEYS,
  CommonFields,
} from './primitives';
import {
  AssistantErrorSection,
  AssistantCompactContent,
  AssistantMessageSection,
} from './assistant-sections';

export function UsageFields({ usage }: { usage: Record<string, unknown> }) {
  const cc = usage.cache_creation as Record<string, unknown> | undefined;
  const stu = usage.server_tool_use as Record<string, unknown> | undefined;
  return (
    <div>
      <LogField label="Input tokens">
        {String(usage.input_tokens ?? 0)}
      </LogField>
      <LogField label="Output tokens">
        {String(usage.output_tokens ?? 0)}
      </LogField>
      {usage.cache_read_input_tokens !== undefined && (
        <LogField label="Cache read">
          {String(usage.cache_read_input_tokens)}
        </LogField>
      )}
      {usage.cache_creation_input_tokens !== undefined && (
        <LogField label="Cache write">
          {String(usage.cache_creation_input_tokens)}
        </LogField>
      )}
      {cc &&
        (Number(cc.ephemeral_1h_input_tokens) > 0 ||
          Number(cc.ephemeral_5m_input_tokens) > 0) && (
          <LogField label="Cache buckets">
            {`1h: ${String(cc.ephemeral_1h_input_tokens ?? 0)}  5m: ${String(cc.ephemeral_5m_input_tokens ?? 0)}`}
          </LogField>
        )}
      {stu &&
        (Number(stu.web_search_requests) > 0 ||
          Number(stu.web_fetch_requests) > 0) && (
          <LogField label="Server tools">
            {`search: ${String(stu.web_search_requests ?? 0)}  fetch: ${String(stu.web_fetch_requests ?? 0)}`}
          </LogField>
        )}
      {usage.service_tier !== undefined && usage.service_tier !== null && (
        <LogField label="Service tier">{String(usage.service_tier)}</LogField>
      )}
      {usage.inference_geo !== undefined &&
        usage.inference_geo !== null &&
        usage.inference_geo !== 'not_available' && (
          <LogField label="Inference geo">
            {String(usage.inference_geo)}
          </LogField>
        )}
    </div>
  );
}

export function ToolUseBlock({ block }: { block: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const input = block.input as Record<string, unknown> | undefined;
  return (
    <div className="border border-border/60 rounded px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold font-mono">
          {String(block.name ?? '(tool)')}
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {String(block.id ?? '').slice(0, 20)}…
        </span>
        {input && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {open ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            input
          </button>
        )}
      </div>
      {open && input && (
        <div className="mt-1.5 space-y-0.5">
          {Object.entries(input).map(([k, v]) => {
            const isLong = typeof v === 'string' && v.length > 80;
            return (
              <div key={k} className="flex gap-2 min-w-0">
                <span className="text-muted-foreground shrink-0 w-28">{k}</span>
                {isLong ? (
                  <pre className="font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-1 max-h-32 overflow-auto flex-1">
                    {v}
                  </pre>
                ) : (
                  <span className="font-mono break-all">
                    {JSON.stringify(v)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ThinkingBlock({ block }: { block: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const text = String(block.thinking ?? '').trim();
  const hasContent = text.length > 0;

  return (
    <div className="border border-border/40 rounded px-2 py-1.5 text-xs bg-muted/10">
      {hasContent ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground w-full text-left"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <span className="italic">thinking</span>
          {!open && (
            <span className="truncate text-[10px] ml-1 text-muted-foreground/70">
              {text.slice(0, 80)}
            </span>
          )}
        </button>
      ) : (
        <span className="italic text-muted-foreground/50">
          thinking (empty)
        </span>
      )}
      {open && (
        <pre className="mt-1.5 font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto text-[11px]">
          {text}
        </pre>
      )}
    </div>
  );
}

export function ContentBlocks({ content }: { content: unknown[] }) {
  return (
    <div className="space-y-1.5 mt-1">
      {content.map((block, i) => {
        if (!block || typeof block !== 'object') return null;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use') return <ToolUseBlock key={i} block={b} />;
        if (b.type === 'thinking') return <ThinkingBlock key={i} block={b} />;
        if (b.type === 'text') {
          return (
            <pre
              key={i}
              className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto"
            >
              {String(b.text ?? '')}
            </pre>
          );
        }
        return <JsonBlock key={i} value={b} />;
      })}
    </div>
  );
}

export function AssistantExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const msg = entry.message as Record<string, unknown> | undefined;
  const known = [
    ...COMMON_KEYS,
    'message',
    'attributionMcpServer',
    'attributionMcpTool',
    'attributionSkill',
    'content',
    'cost',
    'tokens',
    'error',
    'errorDetails',
    'isApiErrorMessage',
    'apiErrorStatus',
  ];

  return (
    <div>
      <CommonFields entry={entry} />

      {/* Error state (rare — rate-limit / invalid-request) */}
      {!!entry.isApiErrorMessage && (
        <AssistantErrorSection
          apiErrorStatus={entry.apiErrorStatus}
          error={entry.error}
          errorDetails={entry.errorDetails}
        />
      )}

      {/* Compact entries (11%) — no message object, just content + cost */}
      {!msg && entry.content !== undefined && (
        <AssistantCompactContent
          content={entry.content}
          cost={entry.cost}
          tokens={entry.tokens}
        />
      )}

      {/* Full message object */}
      {msg && <AssistantMessageSection msg={msg} />}

      {/* Attribution */}
      {(entry.attributionSkill !== undefined ||
        entry.attributionMcpServer !== undefined ||
        entry.attributionMcpTool !== undefined) && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            Attribution
          </div>
          {entry.attributionSkill !== undefined && (
            <LogField label="Skill">{String(entry.attributionSkill)}</LogField>
          )}
          {entry.attributionMcpServer !== undefined && (
            <LogField label="MCP server">
              {String(entry.attributionMcpServer)}
            </LogField>
          )}
          {entry.attributionMcpTool !== undefined && (
            <LogField label="MCP tool">
              {String(entry.attributionMcpTool)}
            </LogField>
          )}
        </div>
      )}

      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}
