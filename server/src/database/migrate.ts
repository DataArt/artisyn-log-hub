import { config } from 'dotenv';
config();

import { isProduction } from '../common/runtime-env';
import {
  initializeDatabase,
  RESET_REFUSED_IN_PRODUCTION_MESSAGE,
} from './database-init';

/**
 * CLI entry point for `npm run migrate` (and `npm run migrate:reset`).
 *
 * Deliberately a thin wrapper: it runs the exact same `initializeDatabase()`
 * the server runs at startup, so the CLI path and the startup path cannot
 * drift apart.
 */
const reset = process.argv.includes('--reset');

// The reset drops the whole public schema — never allow it in production.
if (reset && isProduction()) {
  console.error(RESET_REFUSED_IN_PRODUCTION_MESSAGE);
  process.exit(1);
}

initializeDatabase({ reset }).catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
