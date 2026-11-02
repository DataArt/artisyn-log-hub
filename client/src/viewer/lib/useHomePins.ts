/**
 * The viewer's Home pins (DD-17) over the per-user settings store.
 *
 * Reads `home.pins` from the user-settings query (`userSettingsQuery`, already prefetched by
 * `Bootstrap` for the consent gate, so no extra request) and writes it with
 * `saveUserSetting('home.pins', …)`. A toggle updates the query cache optimistically and rolls it
 * back when the save fails. Without a signed-in user the list is empty and toggling does nothing.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { saveUserSetting } from '../api';
import { useAuth } from '../context/AuthContext';
import type { UserSetting } from '../../models/user-settings';
import { userSettingsQuery } from './consent-queries';
import {
  isPinned,
  parsePins,
  PINS_SETTING_KEY,
  serializePins,
  togglePin,
  type Pin,
} from './home-pins';

const NO_PINS: Pin[] = [];

function pinsOf(settings: readonly UserSetting[] | undefined): Pin[] {
  const raw = settings?.find((s) => s.name === PINS_SETTING_KEY)?.value;
  return raw ? parsePins(raw) : NO_PINS;
}

function withValue(
  settings: readonly UserSetting[] | undefined,
  value: string,
): UserSetting[] {
  const rest = (settings ?? []).filter((s) => s.name !== PINS_SETTING_KEY);
  return [...rest, { name: PINS_SETTING_KEY, value }];
}

export interface UseHomePins {
  pins: Pin[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  isPinned: (pin: Pin) => boolean;
  /** Pins `pin`, or unpins it when it is already pinned. */
  toggle: (pin: Pin) => void;
  /** The last save failed (the optimistic change was rolled back). */
  saveError: boolean;
}

export function useHomePins(): UseHomePins {
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  // The disabled fallback key never fetches: it only keeps the hook call unconditional.
  const query = useQuery({
    ...userSettingsQuery(userId ?? 0),
    enabled: userId !== undefined,
  });
  const pins = useMemo(() => pinsOf(query.data), [query.data]);

  const mutation = useMutation({
    mutationFn: (value: string) => saveUserSetting(PINS_SETTING_KEY, value),
    onMutate: async (value: string) => {
      if (userId === undefined) return { previous: undefined };
      const key = userSettingsQuery(userId).queryKey;
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<UserSetting[]>(key);
      queryClient.setQueryData<UserSetting[]>(key, withValue(previous, value));
      return { previous };
    },
    onError: (_err, _value, context) => {
      if (userId === undefined || context?.previous === undefined) return;
      queryClient.setQueryData<UserSetting[]>(
        userSettingsQuery(userId).queryKey,
        context.previous,
      );
    },
  });
  const { mutate } = mutation;

  const toggle = useCallback(
    (pin: Pin) => {
      if (userId === undefined) return;
      // Read the cache, not the render's `pins`: two quick toggles must build on each other.
      const current = pinsOf(
        queryClient.getQueryData<UserSetting[]>(
          userSettingsQuery(userId).queryKey,
        ),
      );
      mutate(serializePins(togglePin(current, pin)));
    },
    [userId, queryClient, mutate],
  );

  const pinnedCheck = useCallback((pin: Pin) => isPinned(pins, pin), [pins]);
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

  return {
    pins,
    isLoading: userId !== undefined && query.isPending,
    isError: query.isError,
    refetch,
    isPinned: pinnedCheck,
    toggle,
    saveError: mutation.isError,
  };
}
