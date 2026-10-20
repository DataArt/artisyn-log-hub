import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { TeamAccessMode } from '../../../models/teams';
import {
  ACCESS_MODE_BADGE_CLASS,
  ACCESS_MODE_LABEL,
  DISCLOSURE_ALWAYS_VISIBLE_LINE,
  DISCLOSURE_RESTRICTED_BULLETS,
  DISCLOSURE_RESTRICTED_CHECKBOX,
  DISCLOSURE_TRANSPARENT_BULLETS,
  DISCLOSURE_TRANSPARENT_CHECKBOX,
} from '../../lib/access-mode-copy';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

export interface TeamDisclosureModalProps {
  open: boolean;
  teamName: string;
  accessMode: TeamAccessMode;
  /**
   * Whether the team currently has an ADLC trainer. Deliberately does **not**
   * change the copy: the trainer bullet is required to be shown even when
   * no trainer is assigned, because the owner can assign one at any time and
   * that assignment reaches every session already written. Carried on the
   * props because both call sites (the invitation card and the login-time
   * gate) have it from the API and callers should not have to reason about
   * whether it matters.
   */
  hasTrainer?: boolean;
  /** Defaults to the invitation wording from the wireframe. */
  title?: string;
  /** Defaults to `Accept invitation`. */
  acceptLabel?: string;
  /** Renders a spinner on the accept button and blocks re-submission. */
  busy?: boolean;
  /** Server-side rejection (e.g. a stale acknowledged mode — 400). */
  error?: string | null;
  onAccept: () => void;
  /**
   * When omitted the dialog has no Cancel button and cannot be dismissed with
   * Escape or an outside click — the shape the login-time gate needs, where
   * the member is already in the team and the only way forward is to read it.
   */
  onCancel?: () => void;
}

/**
 * Disclosure dialog: states exactly who can read the
 * reader's prompts in this team before they commit to it, and keeps the
 * confirming button disabled until the acknowledgement box is ticked.
 *
 * Every literal comes from `lib/access-mode-copy.ts` so
 * the strings the tests assert on and the strings on screen cannot drift.
 */
export function TeamDisclosureModal(props: TeamDisclosureModalProps) {
  const {
    open,
    teamName,
    accessMode,
    title,
    acceptLabel = 'Accept invitation',
    busy = false,
    error = null,
    onAccept,
    onCancel,
  } = props;

  const [acknowledged, setAcknowledged] = useState(false);

  // A fresh disclosure is a fresh decision: re-opening the dialog, or swapping
  // to the next pending team, must never inherit the previous tick.
  useEffect(() => {
    setAcknowledged(false);
  }, [open, teamName, accessMode]);

  const isRestricted = accessMode === 'restricted';
  const bullets = isRestricted
    ? DISCLOSURE_RESTRICTED_BULLETS
    : DISCLOSURE_TRANSPARENT_BULLETS;
  const checkboxLabel = isRestricted
    ? DISCLOSURE_RESTRICTED_CHECKBOX
    : DISCLOSURE_TRANSPARENT_CHECKBOX;
  const dismissable = onCancel !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissable) onCancel();
      }}
    >
      <DialogContent
        data-testid="team-disclosure-modal"
        showCloseButton={dismissable}
        onEscapeKeyDown={(e) => {
          if (!dismissable) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (!dismissable) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!dismissable) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{title ?? `Before you join ${teamName}`}</span>
            <Badge className={ACCESS_MODE_BADGE_CLASS[accessMode]}>
              {ACCESS_MODE_LABEL[accessMode]}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {DISCLOSURE_ALWAYS_VISIBLE_LINE}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          {bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>

        <label className="flex cursor-pointer select-none items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-border accent-primary"
          />
          <span>{checkboxLabel}</span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          {dismissable && (
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button onClick={onAccept} disabled={!acknowledged || busy}>
            {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {acceptLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
