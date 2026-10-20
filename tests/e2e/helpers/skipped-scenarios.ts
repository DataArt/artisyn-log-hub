/**
 * skipped-scenarios.ts — the "Skipped scenarios" summary globalSetup prints.
 *
 * Some specs only make sense under one AUTH_MODE, and two of them read real
 * emails from a local Mailpit. Those specs skip themselves (or, for Mailpit,
 * fail loudly) at run time; this list states the same conditions up front so
 * a contributor sees, before the run starts, which scenarios the server under
 * test cannot cover and why. Keep it in sync with the `test.skip(...)` calls
 * in the specs it names and with the AUTH_MODE matrix in tests/README.md.
 */

interface GatedSpec {
  spec: string;
  /** Returns the reason the spec will not run, or null when it will run. */
  gate: (mode: string, mailpitReachable: boolean) => string | null;
}

// The mode- and Mailpit-gated specs (password reset, e-mail confirmation) moved to the
// scenario suite (tests/scenarios/auth/), which starts its own stand in every mode.
const GATED_SPECS: GatedSpec[] = [];

/** Environment-dependent skips decided inside a test, listed for visibility. */
const RUNTIME_SKIPS: string[] = [
  'admin-panel.spec.ts "System Info … single-process dev fallback" — skipped when the server is clustered, is a stamped (non-"dev") build, or its DB role cannot read table sizes',
];

/**
 * Lines of the summary, ready to print one per line. `mailpitReachable` is
 * null when Mailpit was not probed (Mode 1, where no spec needs it).
 */
export function skippedScenarioLines(mode: string, mailpitReachable: boolean | null): string[] {
  const mailpitState =
    mailpitReachable === null ? 'not probed' : mailpitReachable ? 'reachable' : 'not reachable';
  const lines = [`[e2e globalSetup] Skipped scenarios (AUTH_MODE=${mode}, Mailpit ${mailpitState}):`];
  const mailpit = mailpitReachable === true;
  const gated = GATED_SPECS.map((s) => ({ spec: s.spec, reason: s.gate(mode, mailpit) })).filter(
    (s): s is { spec: string; reason: string } => s.reason !== null,
  );
  if (gated.length === 0) {
    lines.push('  - none: every mode- and Mailpit-gated spec runs against this server');
  } else {
    for (const { spec, reason } of gated) lines.push(`  - ${spec}: ${reason}`);
  }
  lines.push('  Decided at run time:');
  for (const entry of RUNTIME_SKIPS) lines.push(`  - ${entry}`);
  return lines;
}
