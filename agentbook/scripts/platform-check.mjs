// Platform boundary check for AgentBook. Part of `npm run lint`.
// OS-specific code lives only in crates/platform (the `Platform` trait and its Windows
// implementation), so macOS stays a matter of adding one implementation. This fails, naming each
// file and line, when any other crate's Rust sources or the scenario suite use `cfg(windows)` (or
// another OS cfg) or a Windows-only API, or when any other Cargo.toml declares OS-specific
// dependencies. Comment lines are skipped, so docs may still mention the rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_CRATE = path.join(ROOT, 'crates', 'platform');
const SCAN_ROOTS = [path.join(ROOT, 'crates'), path.join(ROOT, 'tests')];

const RUST_RULES = [
  [/\bcfg(_attr)?\s*\([^)]*\b(windows|unix|target_os|target_family|target_env|target_vendor)\b/, 'OS cfg'],
  [/\bstd::os::(windows|unix|macos|linux)\b/, 'std::os OS-specific module'],
  [/\b(windows_sys|winapi|winreg|windows_core|windows)::/, 'Windows API crate'],
  [/\bextern\s+"system"/, 'system ABI'],
];

const MANIFEST_RULES = [
  [/^\s*\[target\.[^\]]*(windows|unix|target_os|target_family)/, 'OS-specific dependency table'],
  [/^\s*(windows-sys|windows|winapi|winreg|windows-core|rfd)\s*=/, 'Windows-only dependency'],
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === 'node_modules') continue;
      if (path.resolve(full) === ALLOWED_CRATE) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') {
      out.push(full);
    }
  }
}

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);
files.sort();

const bad = [];
for (const file of files) {
  const rules = file.endsWith('.rs') ? RUST_RULES : MANIFEST_RULES;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') && !trimmed.startsWith('#[') && !trimmed.startsWith('#![')) {
      return;
    }
    for (const [re, what] of rules) {
      if (re.test(line)) {
        bad.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${i + 1}: ${what}: ${trimmed}`);
        break;
      }
    }
  });
}

if (bad.length > 0) {
  process.stderr.write(
    `platform-check: ${bad.length} OS-specific line(s) outside crates/platform (move them behind the Platform trait):\n`,
  );
  for (const line of bad) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}
process.stdout.write(`platform-check: ${files.length} files outside crates/platform, no OS-specific code.\n`);
