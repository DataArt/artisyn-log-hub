import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../ui/dialog';
import { Button } from '../../../ui/button';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';

interface Props {
  email: string;
  resetUrl: string;
  onClose: () => void;
}

export function ResetPasswordLinkModal({ email, resetUrl, onClose }: Props) {
  const { copied, copy } = useCopyToClipboard(resetUrl);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Password Reset Link</DialogTitle>
        </DialogHeader>

        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Reset link for <span className="font-medium">{email}</span>:
          </p>
          <code className="rounded border border-border bg-muted/40 p-3 font-mono text-xs break-all">
            {resetUrl}
          </code>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={copy}>
            {copied ? '✓ copied' : 'Copy to clipboard'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
