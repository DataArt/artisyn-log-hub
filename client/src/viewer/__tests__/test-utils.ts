import type { CostBreakdown } from '../../models/repositories';

/**
 * A `RepositorySession.costBreakdown` fixture: a session with no priced cost, no sub-agents,
 * no utility calls and no telemetry. Pass overrides for the parts a test cares about.
 */
export function makeCostBreakdown(
  overrides: Partial<CostBreakdown> = {},
): CostBreakdown {
  return {
    mainCost: null,
    subagentCost: 0,
    utilityCost: 0,
    calculatedCost: null,
    telemetryCost: null,
    mismatch: false,
    utilityPricingMissing: false,
    ...overrides,
  };
}

let hashValue = '';
let initialized = false;

function hashControls() {
  return {
    setHash(hash: string) {
      hashValue = hash;
    },
    resetHash() {
      hashValue = '';
    },
  };
}

export function setupBrowserGlobals() {
  if (initialized) return hashControls();
  initialized = true;

  globalThis.localStorage ??= {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  } as Storage;
  globalThis.window ??= {} as unknown as Window & typeof globalThis;
  (globalThis.window as unknown as Record<string, unknown>).matchMedia ??=
    () => ({
      matches: false,
    });
  if (!window.location) {
    Object.defineProperty(window, 'location', {
      value: {},
      writable: true,
    });
  }
  try {
    Object.defineProperty(window.location, 'hash', {
      get: () => hashValue,
      set: (v: string) => {
        hashValue = v;
      },
      configurable: true,
    });
  } catch {
    // In jsdom, window.location.hash is already defined and non-configurable;
    // the hash polyfill is only needed in the node environment used for SSR tests.
  }

  return hashControls();
}
