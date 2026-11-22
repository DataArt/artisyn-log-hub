/**
 * The hook's PowerShell tool-wrap prefix (`function __lhWrap { … }` plus one `if (Get-Command …)
 * { Set-Item -LiteralPath 'function:<tool>' … }` per wrapped tool) cut off a stored command, so the
 * view shows what the agent typed. Real transcripts keep the typed command, so this is defensive;
 * it recognises the current hook's shape and the 2.28.0 one. Ported from the PoC
 * `docs/pocs/2026-11-22-1443-powershell-format/wrap-prefix.mjs` (`stripWrap`).
 */
import { textOf, withPsTree } from './ps-parse.ts';
import type { BashParser } from './syntax.ts';

const WRAP_START = /^function\s+__lhWrap\b/;
const WRAP_IF =
  /^if\s*\(\s*Get-Command\s+-Name\s+'[^']+'\s+-CommandType\s+Application\b/;
const WRAP_SET = /Set-Item\s+-LiteralPath\s+'function:/;

/**
 * `command` without the leading prefix statements, and without the `;` and blanks after them;
 * `command` unchanged when it does not start with `function __lhWrap` or no prefix statement is
 * recognised.
 */
export function stripLhWrap(parser: BashParser, command: string): string {
  if (!WRAP_START.test(command)) return command;
  return withPsTree(parser, command, (root, src) => {
    const list = root.namedChildren.find((c) => c.type === 'statement_list');
    let end = -1;
    for (const s of list?.namedChildren ?? []) {
      if (s.type === 'empty_statement') continue;
      const t = textOf(src, s);
      const isFn = s.type === 'function_statement' && WRAP_START.test(t);
      const isIf =
        s.type === 'if_statement' && WRAP_IF.test(t) && WRAP_SET.test(t);
      if (!isFn && !isIf) break;
      end = s.endIndex;
    }
    if (end < 0) return command;
    return src.slice(end).replace(/^\s*;\s*/, '');
  });
}
