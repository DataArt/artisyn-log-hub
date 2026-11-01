#!/usr/bin/env node
import { runInstall, runUpgrade, runUninstall, runRestartOtelReceiver, type CliFlags } from './install';
import { EXISTING_CHOICES, type ExistingChoice } from './foreign-otel';

function printUsageAndExit(code: number): never {
  const text = `Usage: artisyn-hooks <install|upgrade|uninstall> [options]
       artisyn-hooks --restart-otel-receiver

install     Install telemetry hooks into the current project.
upgrade     Update an already-installed hook to the latest version.
uninstall   Remove the telemetry hooks plugin from the current project.

Options (install only):
  --server-url <url>   Telemetry server URL (e.g. https://my-server.example.com)
  --api-key <key>      API key for authentication
  --otel-port <n>      Pin the loopback port of the OTEL receiver (1-65535). One
                       receiver serves every repo of this OS user, so this
                       rewrites ~/.artisyn/otel/port.json, the OTEL endpoints in
                       ~/.claude/settings.json and the local settings of every
                       installed repo; restart Claude Code afterwards.
                       Default: allocated once per OS user and remembered.
  --otel-traces=<yes|no>
                       Also export Claude Code traces (enhanced telemetry beta)
                       to the OTEL receiver. Default: ask in a terminal, else yes.
                       The answer is remembered; upgrade reuses it.

Options (install and upgrade):
  --otel-existing=<proxy|keep|replace>
                       What to do when Claude Code already exports OTEL to another
                       collector (in ~/.claude/settings.json or your environment):
                         proxy    Log Hub receives the data and forwards it unchanged
                                  to your collector (OTLP/HTTP JSON only)
                         keep     leave your collector alone; Log Hub OTEL tabs stay empty
                         replace  send the data only to Log Hub
                       Your original keys are backed up to ~/.artisyn/otel/forward.json
                       and restored when the last repo is uninstalled.
                       Default: ask in a terminal, else keep. The answer is
                       remembered until your collector settings change.

Other actions:
  --restart-otel-receiver
                       Stop the per-user OTEL receiver (authenticated); the next
                       Claude Code session starts it again with the installed code.
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
let restartOtelReceiver = false;

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
  } else if (arg.startsWith('--otel-traces=')) {
    const value = arg.slice('--otel-traces='.length).toLowerCase();
    if (value !== 'yes' && value !== 'no') {
      console.error(`Error: --otel-traces must be "yes" or "no" (got "${value}")`);
      process.exit(1);
    }
    flags.otelTraces = value === 'yes';
  } else if (arg.startsWith('--otel-existing=')) {
    const value = arg.slice('--otel-existing='.length).toLowerCase();
    if (!(EXISTING_CHOICES as readonly string[]).includes(value)) {
      console.error(`Error: --otel-existing must be "proxy", "keep" or "replace" (got "${value}")`);
      process.exit(1);
    }
    flags.otelExisting = value as ExistingChoice;
  } else if (arg === '--restart-otel-receiver') {
    restartOtelReceiver = true;
  } else if (arg.startsWith('--')) {
    // Unrecognized flag
    printUsageAndExit(1);
  }
  // Non-flag arguments are left for the subcommand check below
}

// First non-flag arg must be 'install' or 'upgrade'
const subcommand = args.find(a => !a.startsWith('--'));

if (restartOtelReceiver) {
  if (subcommand !== undefined || Object.keys(flags).length > 0) {
    console.error('Error: --restart-otel-receiver is an action of its own — run it without a subcommand or other options');
    printUsageAndExit(1);
  }
  runRestartOtelReceiver().catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'install') {
  runInstall(flags).catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'upgrade') {
  if (flags.serverUrl !== undefined || flags.apiKey !== undefined || flags.otelPort !== undefined || flags.otelTraces !== undefined) {
    console.error('Error: upgrade does not accept --server-url/--api-key/--otel-port/--otel-traces');
    printUsageAndExit(1);
  }

  runUpgrade({ otelExisting: flags.otelExisting }).catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (subcommand === 'uninstall') {
  if (flags.serverUrl !== undefined || flags.apiKey !== undefined || flags.otelPort !== undefined || flags.otelTraces !== undefined
    || flags.otelExisting !== undefined) {
    console.error('Error: uninstall does not accept --server-url/--api-key/--otel-port/--otel-traces/--otel-existing');
    printUsageAndExit(1);
  }

  runUninstall().catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  printUsageAndExit(1);
}