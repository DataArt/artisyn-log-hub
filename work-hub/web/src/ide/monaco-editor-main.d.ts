// `monaco-editor/editor/editor.main` (the editor with every contribution and the Monarch
// languages, without the LSP client of the package root) ships no typings of its own; its exports
// are those of `editor.api`.
declare module "monaco-editor/editor/editor.main" {
  export * from "monaco-editor/editor/editor.api";
}
