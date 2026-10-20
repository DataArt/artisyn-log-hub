import { LogField } from './primitives';

/**
 * Renders expanded content for file-type attachments:
 * file, edited_text_file, compact_file_reference, nested_memory,
 * opened_file_in_ide, selected_lines_in_ide
 */
export function FileAttachmentBody({ att }: { att: Record<string, unknown> }) {
  const t = att.type;

  if (t === 'file' || t === 'edited_text_file') {
    const displayPath = att.displayPath as string | undefined;
    const filename = att.filename as string | undefined;
    const snippet = att.snippet as string | undefined;
    const contentObj = att.content as Record<string, unknown> | undefined;
    const fileContent =
      snippet ??
      (typeof contentObj?.file === 'string' ? contentObj.file : undefined);
    return (
      <div>
        {(displayPath ?? filename) && (
          <LogField label="Path">{displayPath ?? filename}</LogField>
        )}
        {fileContent !== undefined && (
          <div className="mt-1">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
              {fileContent}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (t === 'compact_file_reference' || t === 'nested_memory') {
    const displayPath = att.displayPath as string | undefined;
    const contentObj = att.content as Record<string, unknown> | undefined;
    const text =
      typeof contentObj?.content === 'string' ? contentObj.content : undefined;
    return (
      <div>
        {displayPath && <LogField label="Path">{displayPath}</LogField>}
        {text && (
          <div className="mt-1">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
              {text}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (t === 'opened_file_in_ide' || t === 'selected_lines_in_ide') {
    const displayPath = att.displayPath as string | undefined;
    const filename = att.filename as string | undefined;
    const content = att.content as string | undefined;
    const ideName = att.ideName as string | undefined;
    const lineStart = att.lineStart as number | undefined;
    const lineEnd = att.lineEnd as number | undefined;
    return (
      <div>
        {(displayPath ?? filename) && (
          <LogField label="File">{displayPath ?? filename}</LogField>
        )}
        {ideName && <LogField label="IDE">{ideName}</LogField>}
        {lineStart !== undefined && (
          <LogField label="Lines">
            {lineStart === lineEnd
              ? String(lineStart)
              : `${lineStart}–${lineEnd}`}
          </LogField>
        )}
        {content && (
          <div className="mt-1">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-32 overflow-auto">
              {content}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return null;
}
