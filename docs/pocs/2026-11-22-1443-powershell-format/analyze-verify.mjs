// Runs ps-analyze.mjs over the samples and a corpus: coverage numbers + the FR-9 acceptance example.
// Usage: node analyze-verify.mjs corpus-a.json [corpus-b.json ...]
import { loadParser, readCorpus } from './ps.mjs';
import { analyzePs } from './ps-analyze.mjs';

const { parser } = await loadParser();
const AC = 'Get-Content a.json | ConvertFrom-Json | Set-Content -Path out\\b.json; Remove-Item tmp\\x';
console.log('FR-9 AC:', JSON.stringify(analyzePs(parser, AC)));
for (const s of [
  'Set-Location C:\\work\\acme-app; $d = "tmp/rel"; Remove-Item $d/rows/*.json; Copy-Item -Path src\\a.txt -Destination "out dir\\b.txt"; Move-Item a b; git status 2>$null; npm run build *> build.log',
  'Get-ChildItem -Recurse -Filter *.ts src | Select-String -Pattern TODO; Test-Path -Pa docs\\kb.md; mkdir tmp\\x -Force | Out-Null; Get-Content $env:TEMP\\x.txt; Set-Content Env:FOO 1',
  'Remove-Item a.txt, b.txt -Force -Confirm:$false; & "C:\\Program Files\\Git\\bin\\git.exe" log -1; Rename-Item old.md new.md; iwr https://x/y.zip -OutFile tmp\\y.zip',
]) console.log(JSON.stringify(analyzePs(parser, s)));

const corpus = readCorpus(process.argv.slice(2));
let withFiles = 0, withChanges = 0, withRuns = 0, unresolvedCmds = 0, unresolved = 0, ex = 0;
for (const src of corpus) {
  try {
    const a = analyzePs(parser, src);
    if (a.reads.length || a.changes.length) withFiles++;
    if (a.changes.length) withChanges++;
    if (a.runs.length) withRuns++;
    if (a.unresolved) { unresolvedCmds++; unresolved += a.unresolved; }
  } catch (e) { ex++; if (ex < 3) console.error(e); }
}
console.log({ commands: corpus.length, exceptions: ex, withFiles, withChanges, withRuns, unresolvedCmds, unresolved });
