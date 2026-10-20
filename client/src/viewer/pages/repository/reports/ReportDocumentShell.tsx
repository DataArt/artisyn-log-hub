import type { ReactNode } from 'react';
import { Download, Loader2 } from 'lucide-react';

interface Props {
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  canDownload: boolean;
  onDownload: () => void;
  downloadError: string | null;
  children: ReactNode;
  // Tailwind max-width class for the document card; defaults to the standard
  // 680px "document" width shared by every report. Pass a wider literal
  // (e.g. "max-w-[884px]") for a report whose content needs more room — the
  // class string must be written out in full at the call site for Tailwind's
  // JIT scanner to pick it up.
  maxWidthClassName?: string;
}

// Shared "document card" shell for every report — every selection in the
// Reports tab is now a printable PDF-exportable document (header + KPI table
// + chart/table content), not a dashboard. Zero-result data still renders the
// full document (0-valued KPIs) rather than a generic empty-state message —
// a document meant to be printed/presented should always show its shape.
export function ReportDocumentShell({
  isLoading,
  error,
  onRetry,
  canDownload,
  onDownload,
  downloadError,
  children,
  maxWidthClassName = 'max-w-[680px]',
}: Props) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`flex w-full ${maxWidthClassName} items-center justify-between`}
      >
        <span className="text-sm italic text-muted-foreground">
          On-page preview — the PDF export contains the same data in print
          layout
        </span>
        <button
          onClick={onDownload}
          disabled={!canDownload}
          className="flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:border-input disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Download className="size-3.5" />
          Download as PDF
        </button>
      </div>

      {downloadError && (
        <p className={`w-full ${maxWidthClassName} text-sm text-destructive`}>
          {downloadError}
        </p>
      )}

      {isLoading ? (
        <div
          className={`flex w-full ${maxWidthClassName} flex-1 items-center justify-center gap-2 rounded-md border border-border bg-background py-24`}
        >
          <Loader2 className="size-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading…</span>
        </div>
      ) : error ? (
        <div
          className={`flex w-full ${maxWidthClassName} flex-col items-center justify-center gap-2 rounded-md border border-border bg-background py-24`}
        >
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Failed to load report'}
          </p>
          <button
            onClick={onRetry}
            className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent/50"
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          className={`w-full ${maxWidthClassName} rounded-md border border-border bg-background p-8 shadow-sm`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
