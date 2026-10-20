import { useEffect, useState } from 'react';
import type { ErrorLogEntry } from '../../../../models/admin';
import { fetchErrorLogs } from '../../../api';
import { PageState } from '../../../components/PageState';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../../ui/table';
import { ErrorLogDetailModal } from './ErrorLogDetailModal';

const MAX_ENTRIES = 30;

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

export function SourcePill({ source }: { source: string }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
      {source}
    </span>
  );
}

export function AdminErrorLogsTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<ErrorLogEntry | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(false);

    fetchErrorLogs()
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <PageState message="Loading…" />;
  if (error)
    return <PageState message="Could not load error logs" variant="error" />;
  if (entries.length === 0) return <PageState message="No errors found" />;

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Scanned fresh from the server logs each time this tab is opened
        </span>
        <span>
          Showing {entries.length} of {MAX_ENTRIES} entries
        </span>
      </div>
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => (
              <TableRow
                key={`${entry.timestamp}-${index}`}
                className="cursor-pointer hover:bg-muted/30"
                onClick={() => setSelectedEntry(entry)}
              >
                <TableCell className="font-mono whitespace-nowrap align-top">
                  {formatTimestamp(entry.timestamp)}
                </TableCell>
                <TableCell className="align-top">
                  <SourcePill source={entry.source} />
                </TableCell>
                <TableCell className="whitespace-normal align-top">
                  <div>{entry.message}</div>
                  {entry.details !== null && (
                    <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {entry.details}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {selectedEntry && (
        <ErrorLogDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}
