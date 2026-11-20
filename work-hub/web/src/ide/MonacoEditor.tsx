// The Monaco editor itself (D19). Loaded lazily by `EditorTab`, so Monaco is its own chunk that
// is fetched on the first file tab only.

import Editor from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import styles from "./MonacoEditor.module.css";
import { languageForPath, monaco, MONACO_THEME } from "./monaco-setup";

/** What `EditorTab` needs from the mounted editor. */
export interface MonacoEditorHandle {
  getValue: () => string;
  /** Replaces the whole text (a reload from disk). */
  setValue: (text: string) => void;
}

export interface MonacoEditorProps {
  /** Repo-relative path; picks the language. */
  path: string;
  initialValue: string;
  onChange: (text: string) => void;
  /** Ctrl+S / Cmd+S. */
  onSave: () => void;
  onReady: (handle: MonacoEditorHandle) => void;
}

export default function MonacoEditor({
  path,
  initialValue,
  onChange,
  onSave,
  onReady,
}: MonacoEditorProps) {
  const language = useMemo(() => languageForPath(path), [path]);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  return (
    <Editor
      height="100%"
      theme={MONACO_THEME}
      language={language}
      defaultValue={initialValue}
      loading={<Loader2 className={styles.loader} />}
      options={{
        automaticLayout: true,
        minimap: { enabled: true },
        readOnly: false,
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
      }}
      onChange={(value) => onChange(value ?? "")}
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          onSaveRef.current(),
        );
        onReady({
          getValue: () => editor.getValue(),
          setValue: (text) => editor.setValue(text),
        });
      }}
    />
  );
}
