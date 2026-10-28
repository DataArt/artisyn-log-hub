/**
 * OKF usage — the `tree-sitter-bash` parser on the server (DD-10).
 *
 * The OKF access extraction runs the same Bash analysis as the client's Bash view
 * (`analyzeBash` from `@loghub/bash-view`, FR-20), so the server loads the same WASM runtime and
 * grammar. Nothing is ever executed: commands are only parsed.
 *
 * WASM location: `dist/wasm/<name>` next to the ncc bundle (copied by `scripts/copy-wasm.js`, the
 * scenario stand and the Dockerfile), else the package file in `node_modules` (dev server, jest).
 *
 * Loaded once per process. When loading fails, {@link getServerBashParser} resolves `null` from
 * then on and one warning is logged: Bash calls are then skipped by the extraction, while
 * Read / Grep / Glob / Edit calls are still extracted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { BashParser } from '@loghub/bash-view';
import { Language, Parser, Query } from 'web-tree-sitter';

const logger = new Logger('OkfBashParser');

/** WASM file name → the package path `require.resolve` finds in `node_modules`. */
const WASM_PACKAGE_PATHS: Record<string, string> = {
  'web-tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-bash.wasm': 'tree-sitter-bash/tree-sitter-bash.wasm',
};

/** Absolute path of one WASM file: the bundle's `wasm/` folder first, then `node_modules`. */
function resolveWasm(name: string): string {
  const bundled = join(__dirname, 'wasm', name);
  if (existsSync(bundled)) return bundled;
  return require.resolve(WASM_PACKAGE_PATHS[name] ?? name);
}

async function createServerBashParser(): Promise<BashParser> {
  const runtimeWasm = resolveWasm('web-tree-sitter.wasm');
  await Parser.init({ locateFile: () => runtimeWasm });
  // The grammar is handed over as bytes: given a path, `Language.load` reads it through a dynamic
  // `import('fs/promises')`, which the CommonJS jest runtime cannot run.
  const language = await Language.load(
    readFileSync(resolveWasm('tree-sitter-bash.wasm')),
  );
  const parser = new Parser();
  parser.setLanguage(language);
  const queries = new Map<string, Query>();

  const parse = (src: string) => {
    const tree = parser.parse(src);
    if (!tree) throw new Error('tree-sitter-bash: parse returned no tree');
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
 * The process-wide bash parser, or `null` when the WASM could not be loaded (logged once).
 * The promise is cached, including a failed load: retrying per log would only repeat the
 * same failure and the same warning.
 */
export function getServerBashParser(): Promise<BashParser | null> {
  if (!cached) {
    cached = createServerBashParser().catch((err: unknown) => {
      logger.warn(
        `tree-sitter-bash could not be loaded; OKF access extraction skips Bash calls: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });
  }
  return cached;
}
