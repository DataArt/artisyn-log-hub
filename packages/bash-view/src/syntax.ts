/**
 * Structural types of the `tree-sitter-bash` syntax tree, as far as this package reads it.
 *
 * The package never imports `web-tree-sitter`: each side (browser, server) loads the parser itself
 * and hands in a `BashParser`. `web-tree-sitter`'s own `Parser` / `Tree` / `Node` satisfy these
 * types structurally, so a loader returns its trees as they are.
 */

/** One node of a bash syntax tree (the subset of `web-tree-sitter`'s `Node` this package uses). */
export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  /** UTF-16 code-unit offset of the node's start in the parsed text. */
  readonly startIndex: number;
  /** UTF-16 code-unit offset just past the node's end. */
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly hasError: boolean;
  readonly parent: BashSyntaxNode | null;
  readonly nextSibling: BashSyntaxNode | null;
  readonly children: BashSyntaxNode[];
  readonly namedChildren: BashSyntaxNode[];
  childForFieldName(fieldName: string): BashSyntaxNode | null;
  childrenForFieldName(fieldName: string): BashSyntaxNode[];
  descendantsOfType(type: string): BashSyntaxNode[];
}

/** A parsed tree. It lives in WASM memory: the owner must `delete()` it. */
export interface BashSyntaxTree {
  readonly rootNode: BashSyntaxNode;
  delete(): void;
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
  parse(src: string): BashSyntaxTree;
  /** Runs a highlight query (compiled once per distinct source) over `text`. */
  highlight(text: string, querySource: string): BashCapture[];
}

/**
 * Parses `src`, hands the root node to `fn` and frees the tree afterwards (trees live in WASM
 * memory). `fn` must not keep nodes beyond its own return.
 */
export function withTree<T>(
  parser: BashParser,
  src: string,
  fn: (root: BashSyntaxNode) => T,
): T {
  const tree = parser.parse(src);
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}
