import type { LucideIcon } from 'lucide-react';
import {
  Sparkles,
  Bot,
  Paperclip,
  Camera,
  MessageSquare,
  Settings,
  Shield,
  ArrowLeftRight,
  Terminal,
  FileCode,
  User,
  HelpCircle,
} from 'lucide-react';
import { getAttachmentDetail } from './attachment';

export const TYPE_ICONS: Record<string, LucideIcon> = {
  'ai-title': Sparkles,
  assistant: Bot,
  attachment: Paperclip,
  'file-history-snapshot': Camera,
  'last-prompt': MessageSquare,
  mode: Settings,
  'permission-mode': Shield,
  'queue-operation': ArrowLeftRight,
  system: Terminal,
  'system-context': FileCode,
  user: User,
};

export function getIcon(type: unknown): LucideIcon {
  if (typeof type === 'string' && type in TYPE_ICONS) {
    return TYPE_ICONS[type];
  }
  return HelpCircle;
}

export function getCollapsedSummary(entry: Record<string, unknown>): string {
  const msg = entry.message as Record<string, unknown> | undefined;
  const att = entry.attachment as Record<string, unknown> | undefined;
  const claudeMd = entry.claudeMd as Record<string, unknown> | undefined;

  switch (entry.type) {
    case 'ai-title':
      return String(entry.aiTitle ?? '');
    case 'assistant': {
      const toolNames = Array.isArray(msg?.content)
        ? (msg.content as Record<string, unknown>[])
            .filter((b) => b.type === 'tool_use')
            .map((b) => String(b.name ?? ''))
            .filter(Boolean)
        : [];
      return [
        msg?.model,
        msg?.stop_reason,
        toolNames.length > 0 ? toolNames.join(', ') : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'attachment': {
      const attType = String(att?.type ?? '');
      const detail = getAttachmentDetail(att);
      return detail ? `${attType} · ${detail}` : attType;
    }
    case 'file-history-snapshot':
      return `${String(entry.isSnapshotUpdate)} · ${String(entry.messageId ?? '').slice(0, 8)}`;
    case 'last-prompt':
      return String(entry.lastPrompt ?? '').slice(0, 80);
    case 'mode':
      return String(entry.mode ?? '');
    case 'permission-mode':
      return String(entry.permissionMode ?? '');
    case 'queue-operation':
      return String(entry.operation ?? '');
    case 'system':
      return String(entry.subtype ?? '');
    case 'system-context':
      return `${String(claudeMd?.totalBytes ?? 0)} bytes`;
    case 'user': {
      const content = msg?.content;
      if (Array.isArray(content)) {
        const textBlock = (content as Record<string, unknown>[]).find(
          (b) => b.type === 'text',
        );
        if (textBlock) {
          const firstLine =
            String(textBlock.text ?? '')
              .split('\n')
              .find((l) => l.trim().length > 0) ?? '';
          return firstLine.slice(0, 120);
        }
        const toolResults = (content as Record<string, unknown>[]).filter(
          (b) => b.type === 'tool_result',
        );
        if (toolResults.length > 0) {
          const hasError = toolResults.some((b) => b.is_error === true);
          return `${toolResults.length} tool result${toolResults.length !== 1 ? 's' : ''}${hasError ? ' · error' : ''}`;
        }
        return `${content.length} content block${content.length !== 1 ? 's' : ''}`;
      }
      if (typeof content === 'string') {
        const firstLine =
          content.split('\n').find((l) => l.trim().length > 0) ?? '';
        return firstLine.slice(0, 120);
      }
      // compact entries: content at top level, no message object
      if (typeof entry.content === 'string') {
        const firstLine =
          entry.content.split('\n').find((l) => l.trim().length > 0) ?? '';
        return firstLine.slice(0, 120);
      }
      return '';
    }
    default:
      return String(entry.type ?? '(unknown)');
  }
}

export function sortRawLogs(
  entries: Record<string, unknown>[],
): Record<string, unknown>[] {
  // Assign each entry an effective timestamp for sorting.
  // Entries without a timestamp inherit the last seen timestamp so they
  // stay inline with their neighbours rather than being pushed to the end.
  let lastTs = '';
  const keyed = entries.map((e, i) => {
    const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
    if (ts) lastTs = ts;
    return { e, i, ts: ts ?? lastTs };
  });
  return keyed
    .sort((a, b) => {
      const cmp = a.ts.localeCompare(b.ts);
      return cmp !== 0 ? cmp : a.i - b.i;
    })
    .map((x) => x.e);
}
