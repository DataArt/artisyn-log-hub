// FILES summary of a PowerShell command (FR-9) from the tree-sitter-powershell tree — prototype.
// Same output shape as the Bash view's analyzeBash: { workDir, changes, reads, readAccess, runs, unresolved }.
import { parseSrc, txt } from './ps-format.mjs';

/**
 * Cmdlet table. `pos` = positional parameters in order; `read` / `write` / `del` / `list` / `grep`
 * = which parameters name paths and how; `switches` = parameters that take no value (so the next
 * element is positional). Common value parameters are in COMMON_VALUE.
 */
export const CMDLETS = {
  'Get-Content':   { pos: ['Path'], read: ['Path', 'LiteralPath'], kind: 'read', values: ['TotalCount', 'Tail', 'Head', 'First', 'Last', 'Encoding', 'Delimiter', 'ReadCount', 'Stream', 'Filter', 'Include', 'Exclude'], switches: ['Raw', 'Wait', 'AsByteStream', 'Force'] },
  'Select-String': { pos: ['Pattern', 'Path'], read: ['Path', 'LiteralPath'], kind: 'grep', values: ['Pattern', 'Context', 'Encoding', 'Include', 'Exclude', 'Culture'], switches: ['SimpleMatch', 'CaseSensitive', 'NotMatch', 'List', 'AllMatches', 'Quiet', 'Raw', 'NoEmphasis'] },
  'Get-ChildItem': { pos: ['Path', 'Filter'], read: ['Path', 'LiteralPath'], kind: 'list', values: ['Filter', 'Include', 'Exclude', 'Depth', 'Attributes'], switches: ['Recurse', 'Force', 'Name', 'File', 'Directory', 'Hidden', 'ReadOnly', 'System', 'FollowSymlink'] },
  'Get-Item':      { pos: ['Path'], read: ['Path', 'LiteralPath'], kind: 'list', values: ['Filter', 'Include', 'Exclude', 'Stream'], switches: ['Force'] },
  'Test-Path':     { pos: ['Path'], read: ['Path', 'LiteralPath'], kind: 'list', values: ['Filter', 'Include', 'Exclude', 'PathType', 'OlderThan', 'NewerThan'], switches: ['IsValid'] },
  'Get-FileHash':  { pos: ['Path'], read: ['Path', 'LiteralPath'], kind: 'read', values: ['Algorithm'], switches: [] },
  'Set-Content':   { pos: ['Path', 'Value'], write: ['Path', 'LiteralPath'], values: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream'], switches: ['NoNewline', 'PassThru', 'Force', 'AsByteStream'] },
  'Add-Content':   { pos: ['Path', 'Value'], write: ['Path', 'LiteralPath'], values: ['Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream'], switches: ['NoNewline', 'PassThru', 'Force', 'AsByteStream'] },
  'Clear-Content': { pos: ['Path'], write: ['Path', 'LiteralPath'], values: ['Filter', 'Include', 'Exclude', 'Stream'], switches: ['Force'] },
  'Out-File':      { pos: ['FilePath', 'Encoding'], write: ['FilePath', 'LiteralPath'], values: ['Encoding', 'Width', 'InputObject'], switches: ['Append', 'Force', 'NoClobber', 'NoNewline'] },
  'Tee-Object':    { pos: ['FilePath'], write: ['FilePath', 'LiteralPath'], values: ['Variable', 'InputObject', 'Encoding'], switches: ['Append'] },
  'New-Item':      { pos: ['Path'], write: ['Path'], values: ['ItemType', 'Name', 'Value', 'Target'], switches: ['Force'] },
  'Remove-Item':   { pos: ['Path'], del: ['Path', 'LiteralPath'], values: ['Filter', 'Include', 'Exclude', 'Stream'], switches: ['Recurse', 'Force'] },
  'Copy-Item':     { pos: ['Path', 'Destination'], read: ['Path', 'LiteralPath'], write: ['Destination'], kind: 'read', values: ['Filter', 'Include', 'Exclude', 'ToSession', 'FromSession'], switches: ['Recurse', 'Force', 'PassThru', 'Container'] },
  'Move-Item':     { pos: ['Path', 'Destination'], write: ['Path', 'LiteralPath', 'Destination'], values: ['Filter', 'Include', 'Exclude'], switches: ['Force', 'PassThru'] },
  'Rename-Item':   { pos: ['Path', 'NewName'], write: ['Path', 'LiteralPath', 'NewName'], values: [], switches: ['Force', 'PassThru'] },
  'Expand-Archive':{ pos: ['Path', 'DestinationPath'], read: ['Path', 'LiteralPath'], write: ['DestinationPath'], kind: 'read', values: [], switches: ['Force', 'PassThru'] },
  'Invoke-WebRequest': { pos: ['Uri'], write: ['OutFile'], values: ['Uri', 'Method', 'Body', 'Headers', 'ContentType', 'TimeoutSec', 'OutFile', 'InFile', 'UserAgent', 'Proxy', 'MaximumRedirection'], switches: ['UseBasicParsing', 'PassThru', 'SkipCertificateCheck'], run: true },
};
const ALIASES = {
  gc: 'Get-Content', cat: 'Get-Content', type: 'Get-Content', sls: 'Select-String', gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem',
  gi: 'Get-Item', sc: 'Set-Content', ac: 'Add-Content', clc: 'Clear-Content', tee: 'Tee-Object', ni: 'New-Item',
  ri: 'Remove-Item', rm: 'Remove-Item', del: 'Remove-Item', erase: 'Remove-Item', rd: 'Remove-Item', rmdir: 'Remove-Item',
  cpi: 'Copy-Item', cp: 'Copy-Item', copy: 'Copy-Item', mi: 'Move-Item', mv: 'Move-Item', move: 'Move-Item', rni: 'Rename-Item', ren: 'Rename-Item',
  iwr: 'Invoke-WebRequest', 'invoke-restmethod': 'Invoke-WebRequest', irm: 'Invoke-WebRequest', curl: 'Invoke-WebRequest', wget: 'Invoke-WebRequest',
  mkdir: 'New-Item', md: 'New-Item',
};
const COMMON_VALUE = ['ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable', 'Credential'];
const CD = /^(set-location|cd|sl|chdir|push-location|pushd)$/;
const NOT_RUNS = /^(write-host|write-output|echo|write-verbose|write-warning|write-error|start-sleep|sleep|get-date|out-null|out-string|out-host|select-object|select|where-object|where|\?|foreach-object|foreach|%|sort-object|sort|group-object|measure-object|format-table|ft|format-list|fl|format-wide|convertto-json|convertfrom-json|join-path|split-path|resolve-path|get-location|pwd|pop-location|popd|new-object|get-command|gcm|exit|return|throw)$/;
const SUBCOMMAND_TOOLS = /^(npm|npx|pnpm|yarn|git|docker|bunx|gh|dotnet|mvn|gradle|cargo|go|wsl|winget|choco|scoop)$/;
const RUN_SCRIPT_TOOLS = /^(npm|pnpm|yarn|bun)$/;
/** Non-file provider drives and $null — never a file (counterpart of /dev/* in the Bash view). */
const NOT_A_FILE = /^(\$null|(env|hklm|hkcu|variable|function|alias|cert|wsman):)/i;

/** Unwraps single-child expression chains down to the argument's own node. */
function unwrap(n) { while (n.namedChildCount === 1 && /_expression$|^pipeline(_chain)?$/.test(n.type)) n = n.namedChildren[0]; return n; }

/** Literal value of an argument node with variable substitution from `env`, or null. */
export function literalArg(n0, env) {
  const n = unwrap(n0);
  const t = txt(n);
  const subst = (s) => {
    // $name / ${name} with a literal value in env; anything else → null
    let ok = true;
    const v = s.replace(/\$\{([^}]+)\}|\$([A-Za-z_][\w]*)(?![:\w(])/g, (m, a, b) => { const k = (a ?? b).toLowerCase(); if (k in env) return env[k]; ok = false; return m; });
    return ok && !/[$`]/.test(v.replace(/`([^\n])/g, '')) ? v.replace(/`(.)/g, '$1') : null;
  };
  switch (n.type) {
    case 'generic_token': return /^@/.test(t) ? null : subst(t);
    case 'string_literal': return literalArg(n.namedChildren[0] ?? n, env);
    case 'verbatim_string_characters': return t.slice(1, -1).replace(/''/g, "'");
    case 'expandable_string_literal': return subst(t.slice(1, -1));
    case 'variable': return subst(t);
    case 'integer_literal': case 'decimal_integer_literal': return t;
    default: return null;
  }
}

const isAbs = (p) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);
const joinPath = (cwd, p) => (cwd && !isAbs(p) ? `${cwd.replace(/[\\/]+$/, '')}/${p.replace(/^\.[\\/]/, '')}` : p);

/** Resolves an abbreviated parameter name against a cmdlet's parameter names; null when ambiguous. */
function resolveParam(spec, raw) {
  const p = raw.replace(/^-/, '').replace(/:$/, '').toLowerCase();
  const all = [...new Set([...spec.pos, ...(spec.read ?? []), ...(spec.write ?? []), ...(spec.del ?? []), ...spec.values, ...spec.switches, ...COMMON_VALUE, 'WhatIf', 'Confirm', 'Verbose', 'Debug'])];
  const exact = all.find((x) => x.toLowerCase() === p);
  if (exact) return exact;
  const pref = all.filter((x) => x.toLowerCase().startsWith(p));
  return pref.length === 1 ? pref[0] : null;
}

export function analyzePs(parser, src) {
  const tree = parseSrc(parser, src);
  const res = { workDir: null, changes: [], reads: [], readAccess: [], runs: [], unresolved: 0 };
  const env = {};
  let cwd = null;
  const add = (list, p, kind) => {
    if (p === null) { res.unresolved++; return; }
    if (!p || NOT_A_FILE.test(p) || /^&?\d+$/.test(p)) return;
    const full = joinPath(cwd, p).replace(/\\/g, '/');
    if (list === 'read') { if (!res.reads.includes(full)) { res.reads.push(full); res.readAccess.push({ path: full, kind: kind ?? 'read' }); } }
    else if (!res.changes.includes(full)) res.changes.push(list === 'del' ? full : full) ;
  };
  const run = (l) => { if (!res.runs.includes(l)) res.runs.push(l); };

  const command = (c, inPipe) => {
    const nameNode = c.childForFieldName('command_name');
    if (!nameNode) return;
    const rawName = literalArg(nameNode.namedChildren[0] ?? nameNode, env) ?? (nameNode.type === 'command_name' ? txt(nameNode) : null);
    if (rawName === null) { res.unresolved++; return; }
    const base = rawName.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    // elements; `a.txt, b.txt` arrives as siblings joined by anonymous `,` → one array argument
    const els = [];
    let joinNext = false;
    for (const e of c.childForFieldName('command_elements')?.children ?? []) {
      if (e.type === 'command_argument_sep') continue;
      if (e.type === ',') { joinNext = true; continue; }
      if (joinNext && els.length) { const last = els.at(-1); els[els.length - 1] = { array: [...(last.array ?? [last]), e], type: 'array', startIndex: last.startIndex }; }
      else els.push(e);
      joinNext = false;
    }
    // redirects: real redirection nodes and unspaced `2>$null` / `>out.txt` generic tokens
    const args = [];
    for (const e of els) {
      const t = txt(e);
      if (e.type === 'redirection') {
        const op = txt(e.namedChildren[0] ?? e);
        const dest = e.namedChildren.find((x) => x.type === 'redirected_file_name');
        if (/>/.test(op) && !/&[12]$/.test(op) && dest) add('write', literalArg(dest.namedChildren.at(-1) ?? dest, env));
        continue;
      }
      const m = e.type === 'generic_token' && /^([0-9*]?>>?)(&[12])?(.*)$/.exec(t);
      if (m) { if (!m[2] && m[3]) add('write', NOT_A_FILE.test(m[3]) ? '$null' : /[$`(]/.test(m[3]) ? null : m[3]); continue; }
      args.push(e);
    }
    if (CD.test(base)) {
      if (inPipe) return;
      const a = args.find((e) => e.type !== 'command_parameter');
      const v = a ? literalArg(a, env) : null;
      cwd = v === null ? null : joinPath(cwd, v);
      if (res.workDir === null && cwd) res.workDir = cwd;
      return;
    }
    const cmdlet = CMDLETS[ALIASES[base]] ? ALIASES[base] : Object.keys(CMDLETS).find((k) => k.toLowerCase() === base);
    if (cmdlet) {
      const spec = CMDLETS[cmdlet];
      const bound = {}; const pos = [];
      for (let i = 0; i < args.length; i++) {
        const e = args[i];
        if (e.type === 'command_parameter') {
          const p = resolveParam(spec, txt(e));
          if (!p) continue;
          if (spec.switches.includes(p) || ['WhatIf', 'Confirm', 'Verbose', 'Debug', 'Force'].includes(p)) {
            if (args[i + 1] && /^:/.test(txt(args[i + 1]))) i++; // -Confirm:$false
            continue;
          }
          bound[p] = args[++i] ?? null;
          continue;
        }
        pos.push(e);
      }
      // positional binding, then flatten arrays `a.txt, b.txt`
      spec.pos.forEach((p, k) => { if (!(p in bound) && pos[k]) bound[p] = pos[k]; });
      const vals = (n) => { if (!n) return []; if (n.array) return n.array.map((x) => literalArg(x, env)); const u = unwrap(n); if (u.type === 'array_literal_expression') return u.namedChildren.map((x) => literalArg(x, env)); return [literalArg(n, env)]; };
      if (cmdlet === 'Rename-Item') {
        // both names change; NewName is a name in Path's folder
        const [from] = vals(bound.Path ?? bound.LiteralPath);
        const [to] = vals(bound.NewName);
        add('write', from ?? null);
        add('write', from == null || to == null ? null : from.replace(/[^\\/]*$/, '') + to);
        return;
      }
      const isDir = base === 'mkdir' || base === 'md';
      for (const p of spec.read ?? []) for (const v of vals(bound[p])) add('read', v, spec.kind);
      for (const p of spec.write ?? []) {
        if (cmdlet === 'Rename-Item' && p === 'NewName') continue; // NewName is relative to Path's folder
        for (const v of vals(bound[p])) add('write', v);
      }
      for (const p of spec.del ?? []) for (const v of vals(bound[p])) add('del', v);
      void isDir;
      if (spec.run) run(cmdlet);
      return;
    }
    if (NOT_RUNS.test(base)) return;
    const lits = args.map((e) => literalArg(e, env));
    const sub = lits[0] ?? '';
    run(RUN_SCRIPT_TOOLS.test(base) && sub === 'run' ? `${base} run ${lits[1] ?? '?'}` : SUBCOMMAND_TOOLS.test(base) && sub && !sub.startsWith('-') ? `${base} ${sub}` : base);
  };

  const walk = (n, inPipe) => {
    if (n.type === 'ERROR') return;
    if (n.type === 'command') { command(n, inPipe); for (const c of n.descendantsOfType('script_block')) walk(c, true); return; }
    if (n.type === 'assignment_expression' && n.childForFieldName('value')) {
      // `$x = <literal>` at top level: remember for substitution
      const left = txt(n.namedChildren[0]).trim();
      const val = n.childForFieldName('value');
      const m = /^\$([A-Za-z_]\w*)$/.exec(left);
      if (m) { const v = literalArg(val, env); if (v === null) delete env[m[1].toLowerCase()]; else env[m[1].toLowerCase()] = v; }
      walk(val, inPipe);
      return;
    }
    const pipe = n.type === 'pipeline_chain' && n.namedChildren.filter((x) => x.type === 'command').length > 1;
    for (const c of n.namedChildren) walk(c, inPipe || pipe);
  };
  walk(tree.rootNode, false);
  tree.delete();
  res.reads = res.reads.filter((r) => !res.changes.includes(r));
  res.readAccess = res.readAccess.filter((r) => res.reads.includes(r.path));
  return res;
}
