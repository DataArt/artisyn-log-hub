/**
 * Lazy tree-sitter parsers for the shell command view — one per shell grammar (`bash`,
 * `powershell`), on one shared `web-tree-sitter` runtime.
 *
 * This, `browser-parser.ts` and `powershell-browser-parser.ts` are the only client modules that
 * import `web-tree-sitter` as a value — and only through `import()`, so the runtime (~210 KB) and
 * the grammar WASMs never land in the main bundle, and a grammar is fetched only when a command of
 * its shell is shown. The analysis itself lives in the shared `@loghub/bash-view` package, which
 * takes a `BashParser` argument and never imports `web-tree-sitter`; that keeps it pure and lets
 * the node algorithm tests pass WASM paths resolved with `createRequire` instead of Vite `?url`
 * assets.
 *
 * Nothing is ever executed: commands are only parsed.
 */
import type { BashParser, ShellKind } from '@loghub/bash-view';
import type { Query, Tree } from 'web-tree-sitter';

/** Locations of the two WASM files: Vite `?url` assets in the browser, file paths in node. */
export interface TreeSitterParserAssets {
  /** `web-tree-sitter/web-tree-sitter.wasm` — the tree-sitter runtime. */
  runtimeWasm: string;
  /** The grammar WASM, e.g. `tree-sitter-bash/tree-sitter-bash.wasm`. */
  languageWasm: string;
}

/** Kept for existing callers: the assets of the bash parser. */
export type BashParserAssets = TreeSitterParserAssets;

const cached = new Map<ShellKind, Promise<BashParser>>();

/** `Parser.init` runs once per page, shared by every grammar; a failed init is not cached. */
let runtime: Promise<typeof import('web-tree-sitter')> | null = null;

function initRuntime(
  runtimeWasm: string,
): Promise<typeof import('web-tree-sitter')> {
  runtime ??= import('web-tree-sitter')
    .then(async (mod) => {
      await mod.Parser.init({ locateFile: () => runtimeWasm });
      return mod;
    })
    .catch((err: unknown) => {
      runtime = null;
      throw err;
    });
  return runtime;
}

async function createParser(
  key: ShellKind,
  { runtimeWasm, languageWasm }: TreeSitterParserAssets,
): Promise<BashParser> {
  const { Parser, Language, Query: QueryCtor } = await initRuntime(runtimeWasm);
  const language = await Language.load(languageWasm);
  const parser = new Parser();
  parser.setLanguage(language);
  const queries = new Map<string, Query>();

  const parse = (src: string): Tree => {
    const tree = parser.parse(src);
    if (!tree) throw new Error(`tree-sitter (${key}): parse returned no tree`);
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
 * Loads the parser of one shell grammar once per page (one cached promise per `key`; a failed
 * load is not cached, so a later call can retry). The assets of the first call per key win, and
 * the runtime WASM of the very first call is the one `Parser.init` uses.
 */
export function loadTreeSitterParser(
  key: ShellKind,
  assets: TreeSitterParserAssets,
): Promise<BashParser> {
  let promise = cached.get(key);
  if (!promise) {
    promise = createParser(key, assets).catch((err: unknown) => {
      cached.delete(key);
      throw err;
    });
    cached.set(key, promise);
  }
  return promise;
}

/** The bash parser — `loadTreeSitterParser('bash', assets)`. */
export function loadBashParser(assets: BashParserAssets): Promise<BashParser> {
  return loadTreeSitterParser('bash', assets);
}
