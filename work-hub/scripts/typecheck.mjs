// `npm run typecheck` (from work-hub/): `tsc --noEmit` over the web UI (web/tsconfig.json) and the
// browser test suites (tests/tsconfig.json). Vite and Playwright strip types without checking
// them, so this is the only check that typechecks them. Rust is checked by `cargo clippy
// --all-targets` in `npm run lint`.
// The tests project is skipped with a notice while tests/tsconfig.json does not exist yet.
// The file is .mjs because work-hub/package.json is "type": "module"; the code itself stays
// synchronous and uses only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each project uses the TypeScript installed next to it (web/ is a bun install of its own).
const PROJECTS = [
  {
    name: 'web',
    tsconfig: path.join(ROOT, 'web', 'tsconfig.json'),
    tsc: path.join(ROOT, 'web', 'node_modules', 'typescript', 'bin', 'tsc'),
  },
  {
    name: 'tests',
    tsconfig: path.join(ROOT, 'tests', 'tsconfig.json'),
    tsc: path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  },
];

try {
  let failed = false;
  for (const p of PROJECTS) {
    if (!fs.existsSync(p.tsconfig)) {
      process.stdout.write(`typecheck: ${p.name}: no ${path.relative(ROOT, p.tsconfig)}, skipped\n`);
      continue;
    }
    if (!fs.existsSync(p.tsc)) {
      throw new Error(`TypeScript is not installed for ${p.name} (${p.tsc}); run the install first`);
    }
    process.stdout.write(`typecheck: ${p.name}\n`);
    const r = spawnSync(process.execPath, [p.tsc, '--noEmit', '-p', p.tsconfig], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (r.error) throw r.error;
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
} catch (err) {
  process.stderr.write(`typecheck error: ${err.message}\n`);
  process.exit(1);
}
