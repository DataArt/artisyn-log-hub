import {
  JsonBlock,
  AdditionalFields,
  COMMON_KEYS,
  CommonFields,
} from './primitives';
import { FileAttachmentBody } from './attachment-file';
import { SystemAttachmentBody } from './attachment-system';

/** Returns a one-line detail string for the collapsed attachment summary. */
export function getAttachmentDetail(
  att: Record<string, unknown> | undefined,
): string {
  if (!att) return '';
  switch (att.type) {
    case 'file':
    case 'edited_text_file':
    case 'compact_file_reference':
    case 'nested_memory':
    case 'opened_file_in_ide':
    case 'selected_lines_in_ide':
      return String(att.displayPath ?? att.filename ?? '');
    case 'hook_success':
      return `${String(att.hookName ?? '')} · exit ${String(att.exitCode ?? 0)} · ${String(att.durationMs ?? 0)}ms`;
    case 'date_change':
      return String(att.newDate ?? '');
    case 'task_reminder':
      return `${String(att.itemCount ?? 0)} task(s)`;
    case 'skill_listing':
      return `${String(att.skillCount ?? 0)} skill(s)`;
    case 'command_permissions':
      return `${(att.allowedTools as unknown[])?.length ?? 0} tool(s) allowed`;
    case 'agent_listing_delta':
      return (att.isInitial as boolean)
        ? `initial (${(att.addedTypes as unknown[])?.length ?? 0} agents)`
        : `+${(att.addedTypes as unknown[])?.length ?? 0} -${(att.removedTypes as unknown[])?.length ?? 0}`;
    case 'deferred_tools_delta':
      return `+${(att.addedNames as unknown[])?.length ?? 0} -${(att.removedNames as unknown[])?.length ?? 0}`;
    case 'dynamic_skill':
      return (att.skillNames as string[])?.join(', ') ?? '';
    case 'invoked_skills':
      return `${(att.skills as unknown[])?.length ?? 0} skill(s)`;
    case 'queued_command':
      return String(att.prompt ?? '').slice(0, 60);
    case 'diagnostics':
      return `${(att.files as unknown[])?.length ?? 0} file(s)`;
    case 'plan_mode':
    case 'plan_mode_exit':
      return (
        String(att.planFilePath ?? '')
          .split(/[\\/]/)
          .pop() ?? ''
      );
    default:
      return '';
  }
}

const FILE_TYPES = new Set([
  'file',
  'edited_text_file',
  'compact_file_reference',
  'nested_memory',
  'opened_file_in_ide',
  'selected_lines_in_ide',
]);

const SYSTEM_TYPES = new Set([
  'hook_success',
  'task_reminder',
  'skill_listing',
  'command_permissions',
  'agent_listing_delta',
  'deferred_tools_delta',
  'diagnostics',
  'date_change',
  'plan_mode',
  'plan_mode_exit',
  'queued_command',
  'dynamic_skill',
  'invoked_skills',
]);

export function AttachmentBody({ att }: { att: Record<string, unknown> }) {
  if (FILE_TYPES.has(att.type as string)) {
    return <FileAttachmentBody att={att} />;
  }
  if (SYSTEM_TYPES.has(att.type as string)) {
    return <SystemAttachmentBody att={att} />;
  }
  return <JsonBlock value={att} />;
}

export function AttachmentExpanded({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  const att = entry.attachment as Record<string, unknown> | undefined;
  const known = [...COMMON_KEYS, 'attachment'];
  return (
    <div>
      <CommonFields entry={entry} />
      {att && (
        <div className="mt-2">
          <div className="text-xs text-muted-foreground font-semibold mb-1">
            {`attachment · ${String(att.type ?? 'unknown')}`}
          </div>
          <AttachmentBody att={att} />
        </div>
      )}
      <AdditionalFields entry={entry} knownKeys={known} />
    </div>
  );
}
