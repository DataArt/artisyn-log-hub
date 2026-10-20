import { useEffect, useState } from 'react';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

interface ConfirmDialogProps {
  open: boolean;
  header: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requiresTyping?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  header,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  requiresTyping,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (!open) {
      setInputValue('');
    }
  }, [open]);

  const confirmDisabled =
    requiresTyping !== undefined && inputValue !== requiresTyping;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{header}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {requiresTyping !== undefined && (
          <input
            className="border border-border rounded px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring w-full"
            placeholder={`Type "${requiresTyping}" to confirm`}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
