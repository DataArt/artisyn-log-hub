// Monaco for the IDE (D19). Imported only by the lazily loaded editor chunk, so the workspace
// list and the login pages never load it.
//
// - Offline (NFR-2): `@monaco-editor/react` would load Monaco from a CDN; `loader.config` hands
//   it the locally bundled copy instead.
// - Only the editor worker is bundled (Vite `?worker`); the language-service workers are left out
//   (see vite.config.ts), syntax highlighting comes from the Monarch grammars.

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.main";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });

/** Light theme (NFR-1a). */
export const MONACO_THEME = "vs";

/**
 * JSON has no Monarch grammar in Monaco (its highlighting lives in the JSON language service,
 * which is not bundled), so a small one is registered here.
 */
function registerJson(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === "json")) return;
  monaco.languages.register({
    id: "json",
    aliases: ["JSON", "json"],
    extensions: [
      ".json",
      ".jsonc",
      ".json5",
      ".code-workspace",
      ".babelrc",
      ".eslintrc",
      ".jshintrc",
      ".webmanifest",
    ],
    filenames: [".prettierrc", "composer.lock"],
    mimetypes: ["application/json"],
  });
  monaco.languages.setMonarchTokensProvider("json", {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/[{}[\],:]/, "delimiter"],
      ],
      comment: [
        [/[^*/]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[*/]/, "comment"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("json", {
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  });
}

registerJson();

/**
 * The Monaco language of a file, from its name: an exact `filenames` match first, then the
 * longest matching `extensions` entry; `plaintext` otherwise.
 */
export function languageForPath(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const languages = monaco.languages.getLanguages();
  for (const lang of languages) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
  }
  let best: { id: string; length: number } | null = null;
  for (const lang of languages) {
    for (const ext of lang.extensions ?? []) {
      const e = ext.toLowerCase();
      if (name.endsWith(e) && (best === null || e.length > best.length)) {
        best = { id: lang.id, length: e.length };
      }
    }
  }
  return best?.id ?? "plaintext";
}

export { monaco };
