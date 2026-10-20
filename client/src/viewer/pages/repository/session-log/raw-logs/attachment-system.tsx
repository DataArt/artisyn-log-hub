import { LogField, CollapsibleList } from './primitives';

/**
 * Renders expanded content for system/tool-type attachments:
 * hook_success, task_reminder, skill_listing, command_permissions,
 * agent_listing_delta, deferred_tools_delta, diagnostics, date_change,
 * plan_mode, plan_mode_exit, queued_command, dynamic_skill, invoked_skills
 */
export function SystemAttachmentBody({
  att,
}: {
  att: Record<string, unknown>;
}) {
  const t = att.type;

  if (t === 'hook_success') {
    const stdout = att.stdout as string | undefined;
    const stderr = att.stderr as string | undefined;
    return (
      <div>
        <LogField label="Hook">
          {String(att.hookName ?? att.hookEvent ?? '')}
        </LogField>
        <LogField label="Command">{String(att.command ?? '')}</LogField>
        <LogField label="Exit code">{String(att.exitCode ?? 0)}</LogField>
        <LogField label="Duration">{`${String(att.durationMs ?? 0)} ms`}</LogField>
        {stdout ? (
          <div className="mt-1">
            <div className="text-xs text-muted-foreground font-semibold mb-0.5">
              stdout
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-32 overflow-auto">
              {stdout}
            </pre>
          </div>
        ) : null}
        {stderr ? (
          <div className="mt-1">
            <div className="text-xs text-muted-foreground font-semibold mb-0.5">
              stderr
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-32 overflow-auto">
              {stderr}
            </pre>
          </div>
        ) : null}
      </div>
    );
  }

  if (t === 'task_reminder') {
    const items = (att.content as unknown[]) ?? [];
    return (
      <div>
        <LogField label="Items">
          {String(att.itemCount ?? items.length)}
        </LogField>
        {items.length > 0 && (
          <div className="mt-1 space-y-1">
            {(items as Record<string, unknown>[]).map((task, i) => (
              <div
                key={i}
                className="text-xs font-mono bg-muted/40 rounded p-1.5"
              >
                <span className="text-muted-foreground mr-1">
                  [{String(task.status ?? '?')}]
                </span>
                {String(task.subject ?? task.id ?? '')}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (t === 'skill_listing') {
    const names = (att.names as string[]) ?? [];
    return (
      <div>
        <LogField label="Count">
          {String(att.skillCount ?? names.length)}
        </LogField>
        {names.length > 0 && <CollapsibleList label="Skills" items={names} />}
      </div>
    );
  }

  if (t === 'command_permissions') {
    const tools = (att.allowedTools as string[]) ?? [];
    return (
      <div>
        {tools.length === 0 ? (
          <LogField label="Allowed tools">none</LogField>
        ) : (
          <CollapsibleList label="Allowed tools" items={tools} />
        )}
      </div>
    );
  }

  if (t === 'agent_listing_delta') {
    const added = (att.addedTypes as string[]) ?? [];
    const removed = (att.removedTypes as string[]) ?? [];
    return (
      <div>
        <LogField label="Initial">{String(att.isInitial ?? false)}</LogField>
        {added.length > 0 && (
          <CollapsibleList label="Added agents" items={added} />
        )}
        {removed.length > 0 && (
          <CollapsibleList label="Removed agents" items={removed} />
        )}
      </div>
    );
  }

  if (t === 'deferred_tools_delta') {
    const added = (att.addedNames as string[]) ?? [];
    const removed = (att.removedNames as string[]) ?? [];
    const readded = (att.readdedNames as string[]) ?? [];
    const pending = (att.pendingMcpServers as string[]) ?? [];
    return (
      <div>
        {added.length > 0 && (
          <CollapsibleList label="Added tools" items={added} />
        )}
        {removed.length > 0 && (
          <CollapsibleList label="Removed tools" items={removed} />
        )}
        {readded.length > 0 && (
          <CollapsibleList label="Re-added tools" items={readded} />
        )}
        {pending.length > 0 && (
          <CollapsibleList label="Pending MCP" items={pending} />
        )}
      </div>
    );
  }

  if (t === 'diagnostics') {
    const files = (att.files as Record<string, unknown>[]) ?? [];
    return (
      <div>
        <LogField label="Files">{String(files.length)}</LogField>
        {files.length > 0 && (
          <div className="mt-1 space-y-1">
            {files.map((f, i) => (
              <div
                key={i}
                className="text-xs font-mono text-muted-foreground break-all"
              >
                {String(f.uri ?? f.path ?? '')}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (t === 'date_change') {
    return <LogField label="New date">{String(att.newDate ?? '')}</LogField>;
  }

  if (t === 'plan_mode' || t === 'plan_mode_exit') {
    return (
      <div>
        {att.planFilePath !== undefined && (
          <LogField label="Plan file">
            {String(att.planFilePath).split(/[\\/]/).pop() ?? ''}
          </LogField>
        )}
        {att.planExists !== undefined && (
          <LogField label="Plan exists">{String(att.planExists)}</LogField>
        )}
        {att.reminderType !== undefined && (
          <LogField label="Reminder type">{String(att.reminderType)}</LogField>
        )}
      </div>
    );
  }

  if (t === 'queued_command') {
    return (
      <div>
        <LogField label="Mode">{String(att.commandMode ?? '')}</LogField>
        <div className="mt-1">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto">
            {String(att.prompt ?? '')}
          </pre>
        </div>
      </div>
    );
  }

  if (t === 'dynamic_skill') {
    const names = (att.skillNames as string[]) ?? [];
    return (
      <div>
        {att.displayPath !== undefined && (
          <LogField label="Path">{String(att.displayPath)}</LogField>
        )}
        {names.length > 0 && <CollapsibleList label="Skills" items={names} />}
      </div>
    );
  }

  if (t === 'invoked_skills') {
    const skills = (att.skills as Record<string, unknown>[]) ?? [];
    return (
      <div>
        <LogField label="Count">{String(skills.length)}</LogField>
        {skills.length > 0 && (
          <CollapsibleList
            label="Skills"
            items={skills.map((s) => String(s.name ?? ''))}
          />
        )}
      </div>
    );
  }

  return null;
}
