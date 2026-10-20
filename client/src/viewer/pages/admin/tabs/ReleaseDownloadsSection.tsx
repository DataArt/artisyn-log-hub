import { Fragment, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { ReleaseDownloadLink, ReleaseZip } from '../../../../models';
import { createReleaseDownloadLink, fetchReleaseZips } from '../../../api';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatBytes } from '../../../lib/format';
import { Button } from '../../../ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../../ui/table';

/**
 * Renders the expiry instant in UTC rather than the viewer's locale: the link
 * is handed to someone else, quite possibly in another timezone, so a local
 * wall-clock time would be misleading in the copy-pasted message.
 */
function formatUtcInstant(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function ReleaseLinkPanel({ link }: { link: ReleaseDownloadLink }) {
  const { copied, copy } = useCopyToClipboard(link.url);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {/* Horizontal scroll, not break-all: a selection drag still picks up
            the whole URL as one line. */}
        <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-border bg-muted/40 p-2">
          <code className="font-mono text-[11px]">{link.url}</code>
        </div>
        <Button variant="outline" size="xs" onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        Valid for 24 hours · expires {formatUtcInstant(link.expiresAt)} · anyone
        holding the link can download this zip without signing in · it cannot be
        revoked early.
      </div>
    </div>
  );
}

/**
 * Release Downloads — the admin-only inventory of release zips this instance
 * carries, with a per-file button that mints a temporary unauthenticated
 * download link (see `docs/knowledgebase/release-distribution.md`).
 */
export function ReleaseDownloadsSection() {
  const { data } = useQuery({
    queryKey: ['admin-releases'],
    queryFn: fetchReleaseZips,
  });

  const [links, setLinks] = useState<Record<string, ReleaseDownloadLink>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  // Checked synchronously (unlike state, which only updates on next render) so
  // a rapid second click can't slip through before the button disables.
  const inFlightRef = useRef(false);

  const handleGenerate = async (fileName: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingFile(fileName);
    setFailed((prev) => {
      if (!prev[fileName]) return prev;
      const next = { ...prev };
      delete next[fileName];
      return next;
    });
    try {
      const link = await createReleaseDownloadLink(fileName);
      setLinks((prev) => ({ ...prev, [fileName]: link }));
    } catch {
      setFailed((prev) => ({ ...prev, [fileName]: true }));
    } finally {
      inFlightRef.current = false;
      setPendingFile(null);
    }
  };

  // An instance with no releases directory mounted answers with an empty list;
  // a failed query leaves `data` undefined. Both render the empty-state row —
  // a missing release bundle is never an error state for the admin.
  const entries: ReleaseZip[] = data ?? [];

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Release Downloads
        </span>
        <span className="text-[11px] text-muted-foreground">
          Release bundles this instance carries · visible to administrators only
        </span>
      </div>
      <div className="mt-2 rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Architecture</TableHead>
              <TableHead>Release stamp (UTC)</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No release zips on this instance
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => {
              const link = links[entry.fileName];
              const isPending = pendingFile === entry.fileName;
              return (
                <Fragment key={entry.fileName}>
                  <TableRow>
                    <TableCell className="font-mono text-xs">
                      {entry.fileName}
                    </TableCell>
                    <TableCell>{entry.arch}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {entry.stamp}
                    </TableCell>
                    <TableCell>{formatBytes(entry.sizeBytes)}</TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={isPending}
                        onClick={() => void handleGenerate(entry.fileName)}
                      >
                        {isPending ? (
                          <>
                            <Loader2 className="animate-spin" />
                            Generating…
                          </>
                        ) : link ? (
                          'Regenerate link'
                        ) : (
                          'Generate link'
                        )}
                      </Button>
                      {failed[entry.fileName] && (
                        <div className="mt-1 text-[10px] text-red-500">
                          Could not generate a link
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  {link && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <ReleaseLinkPanel link={link} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
