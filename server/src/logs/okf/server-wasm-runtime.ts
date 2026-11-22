/**
 * OKF usage — the shared `web-tree-sitter` WASM runtime on the server (DD-17).
 *
 * Both server grammars (`server-bash-parser.ts`, `server-powershell-parser.ts`) run on one
 * `web-tree-sitter` runtime; `Parser.init` is done once per process here and cached.
 *
 * WASM location: `dist/wasm/<name>` next to the ncc bundle (copied by `scripts/copy-wasm.js`, the
 * scenario stand and the Dockerfile), else the package file in `node_modules` (dev server, jest).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'web-tree-sitter';

/** WASM file name → the package path `require.resolve` finds in `node_modules`. */
const WASM_PACKAGE_PATHS: Record<string, string> = {
  'web-tree-sitter.wasm': 'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-bash.wasm': 'tree-sitter-bash/tree-sitter-bash.wasm',
  'tree-sitter-powershell.wasm':
    'tree-sitter-powershell/tree-sitter-powershell.wasm',
};

/** Absolute path of one WASM file: the bundle's `wasm/` folder first, then `node_modules`. */
export function resolveWasm(name: string): string {
  const bundled = join(__dirname, 'wasm', name);
  if (existsSync(bundled)) return bundled;
  return require.resolve(WASM_PACKAGE_PATHS[name] ?? name);
}

let runtime: Promise<void> | null = null;

/**
 * Initialises the `web-tree-sitter` runtime once per process. A failed init is cached too: the
 * grammar loaders then fail with the same error and each logs its own single warning.
 */
export function initTreeSitterRuntime(): Promise<void> {
  if (!runtime) {
    runtime = (async () => {
      const runtimeWasm = resolveWasm('web-tree-sitter.wasm');
      await Parser.init({ locateFile: () => runtimeWasm });
    })();
  }
  return runtime;
}
