// ---------------------------------------------------------------------------
// Thin dispatcher — imports all per-type renderers and re-exports the two
// public symbols used by the rest of the app.
// ---------------------------------------------------------------------------

import { JsonBlock } from './primitives';
import { AssistantExpanded } from './assistant';
import { AttachmentExpanded } from './attachment';
import { UserExpanded } from './user';
import { SystemExpanded, SystemContextExpanded } from './system';
import {
  AiTitleExpanded,
  FileHistorySnapshotExpanded,
  LastPromptExpanded,
  ModeExpanded,
  PermissionModeExpanded,
  QueueOperationExpanded,
} from './simple-renderers';

export { getAttachmentDetail } from './attachment';

export function RawLogsExpandedView({
  entry,
}: {
  entry: Record<string, unknown>;
}) {
  switch (entry.type) {
    case 'ai-title':
      return <AiTitleExpanded entry={entry} />;
    case 'assistant':
      return <AssistantExpanded entry={entry} />;
    case 'attachment':
      return <AttachmentExpanded entry={entry} />;
    case 'file-history-snapshot':
      return <FileHistorySnapshotExpanded entry={entry} />;
    case 'last-prompt':
      return <LastPromptExpanded entry={entry} />;
    case 'mode':
      return <ModeExpanded entry={entry} />;
    case 'permission-mode':
      return <PermissionModeExpanded entry={entry} />;
    case 'queue-operation':
      return <QueueOperationExpanded entry={entry} />;
    case 'system':
      return <SystemExpanded entry={entry} />;
    case 'system-context':
      return <SystemContextExpanded entry={entry} />;
    case 'user':
      return <UserExpanded entry={entry} />;
    default:
      return <JsonBlock value={entry} />;
  }
}
