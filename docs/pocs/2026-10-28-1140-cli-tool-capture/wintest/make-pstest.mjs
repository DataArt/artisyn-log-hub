// Builds pstest.ps1: native vs wrapped calls in Windows PowerShell, with the prefix the PreToolUse
// hook would prepend. PATH is reset to a clean Windows one (no Git usr/bin), like Claude's PowerShell tool.
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, 'wintest', 'pslog');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });
const fn = readFileSync(path.join(root, 'shim', 'ps-prefix.template.ps1'), 'utf8').trim().replace('__LOGDIR__', logDir.replace(/'/g, "''"));
const prefix = `${fn}; function zz { __lhWrap 'zz' $args }; function find { __lhWrap 'find' $args }; function ce { __lhWrap 'ce' $args }; `;
const bin = path.join(root, 'wintest', 'bin');
// A clean Windows PATH built from this machine's own locations (no hard-coded install paths).
const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const nodeDir = path.dirname(process.execPath);
const ps = [
  `$env:PATH = '${bin};${sysRoot}\\system32;${sysRoot};' + [Environment]::GetEnvironmentVariable('PATH','User') + ';${nodeDir}'`,
  `Set-Location '${path.join(root, 'sample')}'`,
  `'--- native:'; zz big | Select-Object -First 1; "zz|first exit=$LASTEXITCODE"; find /c "class" src\\main\\java\\com\\acme\\orders\\Order.java; "find exit=$LASTEXITCODE"`,
  prefix,
  `'--- wrapped:'; zz big | Select-Object -First 1; "zz|first exit=$LASTEXITCODE"`,
  `zz fail > $null; "zz fail exit=$LASTEXITCODE"`,
  `find /c "class" src\\main\\java\\com\\acme\\orders\\Order.java; "find exit=$LASTEXITCODE"`,
  `find /c "x" nosuchfile.txt; "find missing exit=$LASTEXITCODE"`,
  `ce callers "findById" | Select-Object -Last 1; "ce exit=$LASTEXITCODE"`,
].join('\r\n');
writeFileSync(path.join(root, 'wintest', 'pstest.ps1'), '\uFEFF' + ps + '\r\n');
