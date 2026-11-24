/**
 * Parsing a PowerShell command with `tree-sitter-powershell`, closing its grammar gaps by a second
 * parse of a same-length masked copy (`ps-mask.ts`).
 *
 * Every PowerShell module reads node text only through `textOf(src, node)` — never `node.text` —
 * because the tree may have been built from the masked copy: offsets are identical, characters
 * are not.
 */
import { maskForParse } from './ps-mask.ts';
import type { BashParser, BashSyntaxNode, BashSyntaxTree } from './syntax.ts';

/** Text of `n` in the original source `src` (the parser may have read a masked copy). */
export const textOf = (src: string, n: BashSyntaxNode): string =>
  src.slice(n.startIndex, n.endIndex);

/**
 * Two-pass parse: the plain tree when it has no error; else the tree of `maskForParse(src).text`
 * when that one has no error; else the plain tree. The chosen tree's root and the ORIGINAL `src`
 * go to `fn`; every tree is deleted afterwards (they live in WASM memory), so `fn` must not keep
 * nodes beyond its own return.
 */
export function withPsTree<T>(
  parser: BashParser,
  src: string,
  fn: (root: BashSyntaxNode, src: string) => T,
): T {
  const plain = parser.parse(src);
  let masked: BashSyntaxTree | null = null;
  try {
    let tree = plain;
    if (plain.rootNode.hasError) {
      const { text, used } = maskForParse(src);
      if (used.length) {
        masked = parser.parse(text);
        if (!masked.rootNode.hasError) tree = masked;
      }
    }
    return fn(tree.rootNode, src);
  } finally {
    plain.delete();
    masked?.delete();
  }
}
