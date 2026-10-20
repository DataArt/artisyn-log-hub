#!/usr/bin/env node
import { runInstall, runUpgrade, runUninstall, type CliFlags } from './install';

function printUsageAndExit(code: number): never {
  const text = `Usage: artisyn-hooks <install|upgrade|uninstall> [options]

install     Install telemetry hooks into the current project.
upgrade     Update an already-installed hook to the latest version.
uninstall   Remove the telemetry hooks plugin from the current project.

Options (install only):
  --server-url <url>   Telemetry server URL (e.g. https://my-server.example.com)
  --api-key <key>      API key for authentication
  --otel-port <n>      Loopback port for the OTEL receiver (1-65535).
                       Default: allocated once per project and remembered.
  --help                Show this help message`;

  if (code === 0) {
    console.log(text);
  } else {
    console.error(text);
  }
  process.exit(code);
}

const args = process.argv.slice(2);

// Check for --help before anything else (a user asking for help shouldn't need a valid subcommand)
if (args.includes('--help')) {
  printUsageAndExit(0);
}

const flags: CliFlags = {};

// Manual argv parsing — no external dependencies
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--server-url') {
    const value = args[i + 1];
    if (value === undefined || value === '') {
      console.error('Error: --server-url requires a non-empty value');
      process.exit(1);
    }
    // Strip trailing slash
    flags.serverUrl = value.replace(/\/+$/, '');
    i++; // consume the value
  } else if (arg === '--api-key') {
    const value = args[i + 1];
    if (value === undefined || value === '') {
      console.error('Error: --api-key requires a non-empty value');
      process.exit(1);
    }
    flags.apiKey = value;
    i++; // consume the value
  } else if (arg === '--otel-port') {
    const value = args[i + 1];
    if (value === undefined || value === '') {
      console.error('Error: --otel-port requires a non-empty value');
      process.exit(1);
    }
    // Strict: `Number(value)` so '31447abc'/'3.5'/'' are rejected rather than silently truncated
    // the way parseInt would truncate them.
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Error: --otel-port must be an integer between 1 and 65535 (got "${value}")`);
      process.exit(1);
    }
    flags.otelPort = port;
    i++; // consume the value
  } else if (arg.startsWith('--')) {
    // Unrecognized flag
    printUsageAndExit(1);
  }
  // Non-flag arguments are left for the subcommand check below
}

// First non-flag arg must be 'install' or 'upgrade'
const subcommand = args.find(a => !a.startsWith('--'));

if (subcommand === 'install') {
  runInstall(flags).catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'upgrade') {
  if (flags.serverUrl !== undefined || flags.apiKey !== undefined || flags.otelPort !== undefined) {
    console.error('Error: upgrade does not accept --server-url/--api-key/--otel-port');
    printUsageAndExit(1);
  }

  runUpgrade().catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'uninstall') {
  if (flags.serverUrl !== undefined || flags.apiKey !== undefined || flags.otelPort !== undefined) {
    console.error('Error: uninstall does not accept --server-url/--api-key/--otel-port');
    printUsageAndExit(1);
  }

  try {
    runUninstall();
  } catch (err: unknown) {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else {
  printUsageAndExit(1);
}