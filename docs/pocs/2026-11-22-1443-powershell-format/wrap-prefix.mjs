// FR-6a: the hook's `__lhWrap` prefix (current hook and the frozen 2.28.0 fixture) — does the grammar
// parse it, and can the leading prefix statements be recognised and cut by syntax?
import { createRequire } from 'node:module';
import { loadParser } from './ps.mjs';
import { parseSrc, txt } from './ps-format.mjs';

const require = createRequire(import.meta.url);
const repo = new URL('../../../', import.meta.url);
const hooks = {
  current: new URL('hook/.claude/telemetry_tool/tool-wrap-powershell.js', repo),
  '2.28.0': new URL('tests/fixtures/legacy-hooks/2.28.0/tool-wrap-powershell.js', repo),
};
const { parser } = await loadParser();

/** Leading statements that are the prefix: `function __lhWrap {…}` and `if (Get-Command -Name '<t>' …) { Set-Item -LiteralPath 'function:<t>' … }`. */
export function stripWrap(src) {
  const tree = parseSrc(parser, src);
  try {
    const list = tree.rootNode.namedChildren.find((c) => c.type === 'statement_list');
    let end = -1;
    for (const s of list?.namedChildren ?? []) {
      if (s.type === 'empty_statement') continue;
      const t = txt(s);
      const isFn = s.type === 'function_statement' && /^function\s+__lhWrap\b/.test(t);
      const isIf = s.type === 'if_statement' && /^if\s*\(\s*Get-Command\s+-Name\s+'[^']+'\s+-CommandType\s+Application\b/.test(t) && /Set-Item\s+-LiteralPath\s+'function:/.test(t);
      if (!isFn && !isIf) break;
      end = s.endIndex;
    }
    if (end < 0 || !/^function\s+__lhWrap\b/.test(src)) return { stripped: false, command: src };
    return { stripped: true, command: src.slice(end).replace(/^\s*;\s*/, '') };
  } finally { tree.delete(); }
}

for (const [name, file] of Object.entries(hooks)) {
  let mod;
  try { mod = require(file.pathname.replace(/^\/([A-Za-z]:)/, '$1')); } catch (e) { console.log(name, 'not loadable:', e.message); continue; }
  const prefix = mod.buildPowerShellPrefix(['git', 'curl'], { sessionDir: 'C:\\x\\sess', sessionId: 'abc', stderrRedirected: false });
  const cmd = 'git status; curl.exe -s https://example.com | Select-Object -First 1';
  const t = parseSrc(parser, prefix + cmd);
  const r = stripWrap(prefix + cmd);
  console.log(`${name}: prefix ${prefix.length} chars, parse error=${t.rootNode.hasError}, stripped=${r.stripped}, equal=${r.command === cmd}`);
  t.delete();
}
console.log('plain command untouched:', stripWrap('git status').command === 'git status');
