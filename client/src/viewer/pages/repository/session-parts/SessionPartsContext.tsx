import { createContext, useContext, type ReactNode } from 'react';

/**
 * On-demand loading of a session's log parts (impl-plan DD-30a): the root parts load with the
 * session, sub-agent parts only when a view asks for them.
 */
export interface SessionPartsValue {
  /** Loads one sub-agent's part (`id` is the bare agent id), plus its descendants when asked. */
  requestAgent(id: string, withDescendants: boolean): Promise<void>;
  /** Loads every part of the session tree. */
  requestAll(): Promise<void>;
  /** Parts with a body in hand (root parts included). */
  loaded: number;
  /** Parts in the manifest. */
  total: number;
  /** True once every part of the manifest is loaded. */
  allLoaded: boolean;
}

const resolved = (): Promise<void> => Promise.resolve();

/** Outside a provider nothing loads lazily: every request resolves at once. */
const DEFAULT_VALUE: SessionPartsValue = {
  requestAgent: resolved,
  requestAll: resolved,
  loaded: 0,
  total: 0,
  allLoaded: true,
};

const SessionPartsContext = createContext<SessionPartsValue>(DEFAULT_VALUE);

export function SessionPartsProvider({
  value,
  children,
}: {
  value: SessionPartsValue;
  children: ReactNode;
}) {
  return (
    <SessionPartsContext.Provider value={value}>
      {children}
    </SessionPartsContext.Provider>
  );
}

export function useSessionParts(): SessionPartsValue {
  return useContext(SessionPartsContext);
}
