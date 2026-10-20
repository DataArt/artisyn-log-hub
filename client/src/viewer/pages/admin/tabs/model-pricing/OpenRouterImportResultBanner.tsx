import { X } from 'lucide-react';
import type { OpenRouterImportResult } from '../../../../../models/pricing';
import { Button } from '../../../../ui/button';

/** Outcome of the last OpenRouter import click, shown until the admin dismisses it. */
export type OpenRouterImportOutcome =
  | { kind: 'success'; result: OpenRouterImportResult }
  | { kind: 'error'; message: string };

interface Props {
  outcome: OpenRouterImportOutcome;
  onDismiss: () => void;
}

/**
 * Inline, dismissible result of the OpenRouter import (the client has no toast
 * component, so the wireframe's toast becomes a banner above the table).
 */
export function OpenRouterImportResultBanner({ outcome, onDismiss }: Props) {
  const isSuccess = outcome.kind === 'success';
  const text = isSuccess
    ? `OpenRouter import finished — ${outcome.result.updated} updated · ${outcome.result.added} added · ${outcome.result.skippedOverride} skipped (override) · 0 Anthropic models touched`
    : `OpenRouter import failed — ${outcome.message} — no prices were changed`;

  return (
    <div
      role={isSuccess ? 'status' : 'alert'}
      data-testid="openrouter-import-result"
      data-outcome={outcome.kind}
      className={
        isSuccess
          ? 'flex items-start gap-2 rounded-md border border-success/50 bg-success/10 px-3 py-2 text-sm text-success'
          : 'flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive'
      }
    >
      <span className="flex-1">{text}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss import result"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
