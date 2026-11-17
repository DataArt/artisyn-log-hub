# Editor choice — 2026-11-13

The owner asked for Monaco or something similar, possibly smarter, with a licence that is neither
paid nor GPL. The preview stays plain text for now.

## Candidates

| Option | Licence | Version (npm, 2026-11-13) | Fit |
|---|---|---|---|
| `monaco-editor` + `@monaco-editor/react` | MIT / MIT | 0.57.0 / 4.7.0 | The VS Code editor component. Brings find/replace, multi-cursor, minimap, read-only mode and a diff editor. Heavy: 2–5 MB depending on the source, so lazy-load it. The React wrapper uses a CDN by default, so it must be pointed at the bundled copy (offline-first). |
| CodeMirror 6 | MIT | 6.0.2 | Modular and light (tens to a few hundred KB). Good on mobile. Needs more assembly for IDE features. Sourcegraph and Replit moved to it for size reasons. |
| `@codingame/monaco-vscode-api` | MIT | 39.0.4 | Modularised VS Code Web: explorer, file service, panels, even the full workbench. The "smarter" option. Its overrides reach into VS Code internals pinned to a commit, and its explorer and file flows would replace Work Hub's own tree, drag and drop, and commit-on-save. |
| `modern-monaco` | MIT | 0.4.2 | A wrapper that removes Monaco's worker and CSS setup and pre-highlights with Shiki. Early (0.4). |
| Ace | BSD-3-Clause | — | Mature but older, with a smaller community. |

## Decision

Monaco through `@monaco-editor/react`, with these settings:

- local loader (no CDN);
- the editor worker only;
- the light `vs` theme;
- a lazy chunk.

`monaco-vscode-api` is the path for later features (extensions, LSP, the workbench), but not the
alpha. See impl-plan D19 and D20.

## Sources

- [PkgPulse — Monaco vs CodeMirror 6 vs Sandpack (2026)](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
- [Sourcegraph — Migrating from Monaco Editor to CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror)
- [Replit — CodeMirror](https://blog.repl.it/codemirror)
- [Browser code editors: Monaco, CodeMirror, Ace (2026)](https://www.pistack.xyz/posts/2026-08-22-browser-code-editors-monaco-codemirror-ace-comparison/)
- [TypeFox — monaco-languageclient v10 / monaco-vscode-api](https://www.typefox.io/blog/monaco-languageclient-v10/)
- [@codingame/monaco-editor-wrapper README](https://cdn.jsdelivr.net/npm/@codingame/monaco-editor-wrapper@31.0.0/README.md)
- [modern-monaco README](https://cdn.jsdelivr.net/npm/modern-monaco@0.4.2/README.md)
- Licences and versions: `npm view <pkg> license version`, `cargo info <crate>` (2026-11-13).
