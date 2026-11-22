// Hand-written samples: acceptance-criteria shapes and PowerShell 7-only syntax.
// Usage: node samples.mjs  → prints each formatted sample, writes out-sample-pairs.json for oracle.ps1
// and out-ts-errors.json (corpus commands tree-sitter cannot parse, as {src, fmt: src}).
import { writeFileSync } from 'node:fs';
import { loadParser, readCorpus } from './ps.mjs';
import { makeFormatter, liftCd, foldHereStrings, parseSrc, txt, setMasking } from './ps-format.mjs';

export const SAMPLES = [
  'Set-Location D:\\work\\acme-app; Get-Content a.json | ConvertFrom-Json | Select-Object -ExpandProperty items | Set-Content -Path out\\b.json; Remove-Item tmp\\x',
  'Get-ChildItem -Recurse -Filter *.ts src | Where-Object { $_.Length -gt 10000 } | ForEach-Object { $n = $_.FullName; $c = (Get-Content $n).Count; "$c $n" } | Sort-Object -Descending | Select-Object -First 20',
  "$body = @'\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n'@; Set-Content -Path notes.md -Value $body -Encoding utf8; foreach ($f in Get-ChildItem *.md) { if ($f.Length -gt 0) { Write-Output $f.Name } else { Remove-Item $f } }",
  'npm run build && npm test || Write-Host "build or tests failed, see the output above for the details of the failure"',
  '$mode = $env:CI ? "ci" : "local"; $port = $env:PORT ?? 3000; $name = $cfg?.server?.name; npm run start -- --port $port --mode $mode',
  'try { $r = Invoke-RestMethod http://localhost:3000/health -TimeoutSec 5; "ok $($r.status)" } catch { "down: $($_.Exception.Message)" } finally { Get-Date -Format HH:mm:ss }',
  '$s = (Get-ChildItem -Recurse node_modules | Measure-Object Length -Sum).Sum / 1MB; npm ls @nestjs/core; Select-String -Path $HOME\\.claude\\settings.json -Pattern hooks; git rev-parse HEAD^{tree}',
  'git status --short 2>$null; npm ci *>$null; Get-Process node -ErrorAction SilentlyContinue | Out-Null; & "C:\\Program Files\\Git\\bin\\git.exe" log -1 --format=%H',
];

const { parser } = await loadParser();
const { format } = makeFormatter();
const pairs = [];
for (const src of SAMPLES) {
  const f = format(parser, src);
  const l = f.ok ? liftCd(parser, src, f.script) : { workDir: null, script: f.script };
  const h = f.ok ? foldHereStrings(parser, src, l.script) : { script: l.script, folded: [] };
  console.log(`\n=== ok=${f.ok} partial=${!!f.partial} workDir=${l.workDir} folded=${h.folded.length}\n${h.script}`);
  pairs.push({ src, fmt: f.script });
}
writeFileSync('out-sample-pairs.json', JSON.stringify(pairs));

const corpusFiles = process.argv.slice(2);
if (corpusFiles.length) {
  const errs = readCorpus(corpusFiles).filter((src) => { const t = parseSrc(parser, src); const e = t.rootNode.hasError; t.delete(); return e; });
  writeFileSync('out-ts-errors.json', JSON.stringify(errs.map((src) => ({ src, fmt: src }))));
  console.log(`\ntree-sitter errors: ${errs.length} → out-ts-errors.json`);
}
