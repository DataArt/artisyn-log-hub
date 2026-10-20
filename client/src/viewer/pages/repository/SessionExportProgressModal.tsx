import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

interface Props {
  open: boolean;
  completed: number;
  total: number;
}

/**
 * Non-dismissible progress modal shown while `session-export-runner.ts` fetches and packages
 * the "Session Statistics Export". Closes automatically once the caller sets `open` to
 * false after the download is triggered — there is no cancel button (not required by
 * acceptance criteria).
 */
export function SessionExportProgressModal({ open, completed, total }: Props) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Exporting session statistics</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <p className="text-sm text-muted-foreground">
            {total > 0
              ? `${completed} / ${total} sessions`
              : 'Preparing export…'}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
