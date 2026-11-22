// Today's commit regex anchor vs. a PowerShell-aware one on hand-written PowerShell spellings (FR-12).
const G = String.raw`(?:(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[\w])\s+)*`;
const TODAY = String.raw`(?:^|[\n;&|])\s*`;
// also after `{` / `(`, with an optional call operator `&` and quotes, and `git.exe`
const PS = String.raw`(?:^|[\n;&|{(])\s*(?:&\s*)?['"]?`;
const count = (s, anchor, exe) =>
  (s.match(new RegExp(String.raw`${anchor}git${exe ? String.raw`(?:\.exe)?['"]?` : ''}\s+${G}commit(?![-\w])`, 'g')) ?? []).length;
for (const s of [
  'git add .; git commit -m x',
  'if ($?) { git commit -m x }',
  '& git commit -m x',
  'git.exe commit -m x',
  '& "git.exe" commit -m x',
  'npm test && git commit -m x',
  'Write-Host "then git commit"',
  '(git commit -m x) | Out-Null',
]) console.log(`today=${count(s, TODAY, false)} ps=${count(s, PS, true)}  ${s}`);
