/**
 * OKF usage — both server shell parsers in one value (DD-17).
 *
 * `ShellParsers` is what the OKF extraction takes (`extractOkfDetail`, `collectNodeFileFacts`):
 * each grammar is loaded by its own cached getter, so a missing grammar is `null` and skips only
 * that shell's calls. Cached per process.
 */
import type { ShellParsers } from '@loghub/bash-view';
import { getServerBashParser } from './server-bash-parser';
import { getServerPowerShellParser } from './server-powershell-parser';

let cached: Promise<ShellParsers> | null = null;

/** The process-wide Bash and PowerShell parsers (either `null` when its WASM failed to load). */
export function getServerShellParsers(): Promise<ShellParsers> {
  if (!cached) {
    cached = Promise.all([
      getServerBashParser(),
      getServerPowerShellParser(),
    ]).then(([bash, powershell]) => ({ bash, powershell }));
  }
  return cached;
}
