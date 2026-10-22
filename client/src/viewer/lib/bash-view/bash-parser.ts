/**
 * Lazy `tree-sitter-bash` parser for the Bash command view.
 *
 * This and `browser-parser.ts` are the only modules that import `web-tree-sitter` as a value —
 * and only through `import()`, so the runtime (~210 KB) and the bash grammar (~1.36 MB WASM) never
 * land in the main bundle. Every other `bash-view` module takes a `BashParser` argument and uses
 * `import type` only, which keeps them pure and lets the node algorithm test pass WASM paths
 * resolved with `createRequire` instead of Vite `?url` assets.
 *
 * Nothing is ever executed: commands are only parsed.
 */
import type { Node, Query, Tree } from 'web-tree-sitter';

/** Locations of the two WASM files: Vite `?url` assets in the browser, file paths in node. */
export interface BashParserAssets {
  /** `web-tree-sitter/web-tree-sitter.wasm` — the tree-sitter runtime. */
  runtimeWasm: string;
  /** `tree-sitter-bash/tree-sitter-bash.wasm` — the bash grammar. */
  languageWasm: string;
}

/**
 * One capture of a highlight query, flattened to plain offsets (UTF-16 code units into the parsed
 * text), so it stays valid after the syntax tree that produced it has been freed.
 */
export interface BashCapture {
  /** The capture name without `@`, e.g. `keyword`, `string`, `redirect`. */
  name: string;
  start: number;
  end: number;
}

export interface BashParser {
  /** Parses `src`. The caller owns the tree and must `delete()` it — or use `withTree`. */
  parse(src: string): Tree;
  /** Runs a highlight query (compiled once per distinct source) over `text`. */
  highlight(text: string, querySource: string): BashCapture[];
}

let cached: Promise<BashParser> | null = null;

async function createBashParser({
  runtimeWasm,
  languageWasm,
}: BashParserAssets): Promise<BashParser> {
  const {
    Parser,
    Language,
    Query: QueryCtor,
  } = await import('web-tree-sitter');
  await Parser.init({ locateFile: () => runtimeWasm });
  const language = await Language.load(languageWasm);
  const parser = new Parser();
  parser.setLanguage(language);
  const queries = new Map<string, Query>();

  const parse = (src: string): Tree => {
    const tree = parser.parse(src);
    if (!tree) throw new Error('tree-sitter-bash: parse returned no tree');
    return tree;
  };

  return {
    parse,
    highlight(text, querySource) {
      let query = queries.get(querySource);
      if (!query) {
        query = new QueryCtor(language, querySource);
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

/**
 * Loads the bash parser once per page (the promise is cached; a failed load is not, so a later
 * call can retry). The assets of the first call win.
 */
export function loadBashParser(assets: BashParserAssets): Promise<BashParser> {
  if (!cached) {
    cached = createBashParser(assets).catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/**
 * Parses `src`, hands the root node to `fn` and frees the tree afterwards (trees live in WASM
 * memory). `fn` must not keep nodes beyond its own return.
 */
export function withTree<T>(
  parser: BashParser,
  src: string,
  fn: (root: Node) => T,
): T {
  const tree = parser.parse(src);
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}
