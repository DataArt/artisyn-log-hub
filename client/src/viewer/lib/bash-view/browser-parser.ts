/**
 * Browser entry of the bash parser: the WASM files as Vite `?url` assets and the grammar's own
 * highlight query as `?raw` text.
 *
 * Never import this module statically — it is reachable only through `import()` (from
 * `useBashView`), so neither WASM file nor the query is part of the main bundle.
 */
import highlightsScm from 'tree-sitter-bash/queries/highlights.scm?raw';
import languageWasm from 'tree-sitter-bash/tree-sitter-bash.wasm?url';
import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { bashHighlightQuery } from './bash-highlight';
import { type BashParser, loadBashParser } from './bash-parser';

/** `tree-sitter-bash/queries/highlights.scm` plus `(file_redirect) @redirect` (`bashHighlightQuery`). */
export const HIGHLIGHT_QUERY = bashHighlightQuery(highlightsScm);

export function getBrowserBashParser(): Promise<BashParser> {
  return loadBashParser({ runtimeWasm, languageWasm });
}
