/**
 * Browser entry of the PowerShell parser: the WASM files as Vite `?url` assets and the grammar's
 * own highlight query as `?raw` text.
 *
 * Never import this module statically — it is reachable only through `import()` (from
 * `useBashView`), so a session without PowerShell calls never requests the PowerShell grammar
 * WASM or its query.
 */
import { type BashParser, powershellHighlightQuery } from '@loghub/bash-view';
import highlightsScm from 'tree-sitter-powershell/queries/highlights.scm?raw';
import languageWasm from 'tree-sitter-powershell/tree-sitter-powershell.wasm?url';
import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { loadTreeSitterParser } from './bash-parser';

/** `tree-sitter-powershell/queries/highlights.scm` adapted by `powershellHighlightQuery`. */
export const PS_HIGHLIGHT_QUERY = powershellHighlightQuery(highlightsScm);

export function getBrowserPowerShellParser(): Promise<BashParser> {
  return loadTreeSitterParser('powershell', { runtimeWasm, languageWasm });
}
