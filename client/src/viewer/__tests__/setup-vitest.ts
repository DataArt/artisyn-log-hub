// Vitest setup file (listed in client/vite.config.ts `test.setupFiles`): installs the
// browser globals once. test-utils.ts stays a pure export with no import side effects.
import { setupBrowserGlobals } from './test-utils';

setupBrowserGlobals();
