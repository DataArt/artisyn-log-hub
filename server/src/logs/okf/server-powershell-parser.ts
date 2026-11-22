/**
 * OKF usage — the `tree-sitter-powershell` parser on the server (DD-17).
 *
 * The OKF access extraction analyses PowerShell calls with the same rules as the client's Shell
 * view (`analyzeShellCommand` from `@loghub/bash-view`), so the server loads the same grammar.
 * Nothing is ever executed: commands are only parsed. Mirrors `server-bash-parser.ts`; the
 * runtime init and the WASM location rule are shared (`server-wasm-runtime.ts`).
 *
 * Loaded once per process. When loading fails, {@link getServerPowerShellParser} resolves `null`
 * from then on and one warning is logged: PowerShell calls are then skipped by the extraction,
 * while Bash / Read / Grep / Glob / Edit calls are still extracted.
 */
import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import type { BashParser } from '@loghub/bash-view';
import { Language, Parser, Query } from 'web-tree-sitter';
import { initTreeSitterRuntime, resolveWasm } from './server-wasm-runtime';

const logger = new Logger('OkfPowerShellParser');

async function createServerPowerShellParser(): Promise<BashParser> {
  await initTreeSitterRuntime();
  // The grammar is handed over as bytes: given a path, `Language.load` reads it through a dynamic
  // `import('fs/promises')`, which the CommonJS jest runtime cannot run.
  const language = await Language.load(
    readFileSync(resolveWasm('tree-sitter-powershell.wasm')),
  );
  const parser = new Parser();
  parser.setLanguage(language);
  const queries = new Map<string, Query>();

  const parse = (src: string) => {
    const tree = parser.parse(src);
    if (!tree)
      throw new Error('tree-sitter-powershell: parse returned no tree');
    return tree;
  };

  return {
    parse,
    highlight(text, querySource) {
      let query = queries.get(querySource);
      if (!query) {
        query = new Query(language, querySource);
        queries.set(querySource, query);
      }
      const tree = parse(text);
      try {
        return query.captures(tree.rootNode).map((c) => ({
          name: c.name,
          start: c.node.startIndex,
          end: c.node.endIndex,
        }));
      } finally {
        tree.delete();
      }
    },
  };
}

let cached: Promise<BashParser | null> | null = null;

/**
 * The process-wide PowerShell parser, or `null` when the WASM could not be loaded (logged once).
 * The promise is cached, including a failed load: retrying per log would only repeat the same
 * failure and the same warning.
 */
export function getServerPowerShellParser(): Promise<BashParser | null> {
  if (!cached) {
    cached = createServerPowerShellParser().catch((err: unknown) => {
      logger.warn(
        `tree-sitter-powershell could not be loaded; OKF access extraction skips PowerShell calls: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });
  }
  return cached;
}
