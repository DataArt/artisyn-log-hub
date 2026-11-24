// What the FILES analysis (FR-9) has to cover, measured on the corpus:
// command-name frequencies, parameters used with the closed cmdlet list, redirect shapes,
// provider paths, call operator, how arguments look (literal / variable-built).
// Usage: node analyze-stats.mjs corpus-a.json [corpus-b.json ...]
import { loadParser, readCorpus } from './ps.mjs';
import { parseSrc, txt } from './ps-format.mjs';

// FR-9 closed list (aliases → cmdlet), lower case
const ALIAS = {
  'get-content': 'Get-Content', gc: 'Get-Content', cat: 'Get-Content', type: 'Get-Content',
  'select-string': 'Select-String', sls: 'Select-String',
  'get-childitem': 'Get-ChildItem', gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem',
  'get-item': 'Get-Item', gi: 'Get-Item', 'test-path': 'Test-Path',
  'set-content': 'Set-Content', sc: 'Set-Content', 'add-content': 'Add-Content', ac: 'Add-Content',
  'clear-content': 'Clear-Content', clc: 'Clear-Content', 'out-file': 'Out-File',
  'tee-object': 'Tee-Object', tee: 'Tee-Object', 'new-item': 'New-Item', ni: 'New-Item',
  mkdir: 'mkdir', md: 'mkdir',
  'remove-item': 'Remove-Item', ri: 'Remove-Item', rm: 'Remove-Item', del: 'Remove-Item', erase: 'Remove-Item', rd: 'Remove-Item', rmdir: 'Remove-Item',
  'copy-item': 'Copy-Item', cpi: 'Copy-Item', cp: 'Copy-Item', copy: 'Copy-Item',
  'move-item': 'Move-Item', mi: 'Move-Item', mv: 'Move-Item', move: 'Move-Item',
  'rename-item': 'Rename-Item', rni: 'Rename-Item', ren: 'Rename-Item',
};

const files = process.argv.slice(2);
const corpus = readCorpus(files);
const { parser } = await loadParser();

const names = {};
const listParams = {};
const listPositional = {};
const argKinds = { literal: 0, variable: 0, subexpr: 0, other: 0 };
let unspacedRedirect = 0, redirectNodes = 0, nullRedirect = 0, outNull = 0, callOp = 0, provider = 0;
const providerSamples = new Set();
const unknownFileish = {};
const FILEISH = /^(import-csv|export-csv|expand-archive|compress-archive|get-filehash|resolve-path|split-path|join-path|invoke-webrequest|iwr|invoke-restmethod|irm|start-process|import-module|convertto-json|convertfrom-json|get-acl|set-location|push-location|pop-location|cd|sl|pushd|popd|measure-object|format-hex|get-itemproperty|set-itemproperty|new-itemproperty|remove-itemproperty|invoke-item|ii|start|saps|unblock-file|sort-object|out-string|write-output|echo|write-host|copy|xcopy|robocopy|attrib|icacls|tar|7z|curl\.exe|curl|wget)$/;

for (const src of corpus) {
  const tree = parseSrc(parser, src);
  for (const c of tree.rootNode.descendantsOfType('command')) {
    const nameNode = c.childForFieldName('command_name');
    if (!nameNode) continue;
    const raw = txt(nameNode);
    const name = raw.toLowerCase().replace(/\.exe$/, '');
    if (c.children.some((k) => k.type === 'command_invokation_operator')) callOp++;
    names[name] = (names[name] || 0) + 1;
    if (FILEISH.test(name)) unknownFileish[name] = (unknownFileish[name] || 0) + 1;
    const els = (c.childForFieldName('command_elements')?.namedChildren ?? []).filter((e) => e.type !== 'command_argument_sep');
    for (const e of els) {
      const t = txt(e);
      if (e.type === 'redirection') { redirectNodes++; if (/\$null/i.test(t)) nullRedirect++; }
      if (e.type === 'generic_token' && /^[0-9*]?>>?(&[12])?/.test(t)) { unspacedRedirect++; if (/\$null/i.test(t)) nullRedirect++; }
      if (/^(env|hklm|hkcu|variable|function|alias|cert):/i.test(t.replace(/^['"]/, ''))) { provider++; providerSamples.add(t.slice(0, 30)); }
    }
    if (name === 'out-null') outNull++;
    const cmdlet = ALIAS[name];
    if (!cmdlet) continue;
    let pos = 0;
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      const t = txt(e);
      if (e.type === 'command_parameter') {
        const p = t.replace(/:$/, '').toLowerCase();
        const key = `${cmdlet} ${p}`;
        listParams[key] = (listParams[key] || 0) + 1;
        continue;
      }
      if (e.type === 'redirection') continue;
      pos++;
      if (e.type === 'generic_token' || e.type === 'string_literal') {
        if (/\$\(/.test(t)) argKinds.subexpr++;
        else if (/\$/.test(t) && !(e.type === 'string_literal' && t.startsWith("'"))) argKinds.variable++;
        else argKinds.literal++;
      } else if (e.type === 'variable') argKinds.variable++;
      else argKinds.other++;
    }
    listPositional[cmdlet] = (listPositional[cmdlet] || 0) + 1;
  }
  tree.delete();
}

const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
console.log('commands:', corpus.length);
console.log('\nTop command names (calls):'); console.log(top(names, 70).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('\nFile-ish commands outside the closed list:'); console.log(top(unknownFileish, 40).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('\nClosed-list cmdlets used (commands):', listPositional);
console.log('\nParameters used with closed-list cmdlets:'); console.log(top(listParams, 80).map(([k, v]) => `${k}:${v}`).join('\n'));
console.log('\nArgument kinds of closed-list cmdlets:', argKinds);
console.log({ redirectNodes, unspacedRedirect, nullRedirect, outNull, callOp, provider, providerSamples: [...providerSamples].slice(0, 10) });
