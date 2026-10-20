import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PendingDisclosure } from '../../../models/teams';
import { acknowledgeTeamDisclosure, fetchPendingDisclosures } from '../../api';
import { TeamDisclosureModal } from './TeamDisclosureModal';

/**
 * A member can end up in a team without ever passing the invitation
 * flow — a force-invite by an admin, or `addMemberIfRealUser` during a repo
 * import. Those members never saw the disclosure, so it is shown at their next
 * login instead, one team at a time, and cannot be dismissed without
 * acknowledging: their sessions stay invisible to the team until they do
 * (`disclosure_acknowledged_at`).
 */
export function PendingDisclosureGate() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: pending = [] } = useQuery({
    queryKey: ['pending-disclosures'],
    queryFn: fetchPendingDisclosures,
  });

  // Strictly one at a time: acknowledging the head of the list refetches and
  // the next one takes its place, so a member added to three teams reads three
  // separate disclosures rather than one merged wall of text.
  const current: PendingDisclosure | undefined = pending[0];

  const acknowledge = useMutation({
    mutationFn: (disclosure: PendingDisclosure) =>
      acknowledgeTeamDisclosure(disclosure.teamId, disclosure.accessMode),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['pending-disclosures'] });
      // The acknowledgement widens what the team owner and trainers see, and
      // the member's own team views are unaffected — but the teams list is the
      // cheapest thing to keep honest after a membership-shaped change.
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
    onError: (err: unknown) => {
      // A 400 here means the team's mode changed while the modal was open, so
      // the refetch below replaces the copy with the mode actually in force.
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not record your acknowledgement. Please try again.',
      );
      void queryClient.invalidateQueries({ queryKey: ['pending-disclosures'] });
    },
  });

  if (!current) return null;

  return (
    <TeamDisclosureModal
      open
      teamName={current.teamName}
      accessMode={current.accessMode}
      hasTrainer={current.hasTrainer}
      title={`You were added to ${current.teamName}`}
      acceptLabel="Acknowledge"
      busy={acknowledge.isPending}
      error={error}
      onAccept={() => acknowledge.mutate(current)}
    />
  );
}
