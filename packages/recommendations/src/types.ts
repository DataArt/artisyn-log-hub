/** Who can switch a startup context group off. `user` is shown as "user profile" in the UI. */
export type Controller = 'built-in' | 'claudeai-account' | 'org' | 'user' | 'project';

/** What the matcher knows about a session's startup context. Built by the client adapter. */
export interface StartupFacts {
  /** Characters per token (anatomy `cpt`). */
  cpt: number;
  /** Share denominator (anatomy `denominator`). */
  denominator: number;
  /** Tool definitions; `null` = no tools source. */
  tools: { name: string; bytes: number }[] | null;
  /** A harness snapshot exists. */
  snapshot: boolean;
  mcpServers: StartupMcpServer[];
  skills: { name: string; bytes: number; source: string | null; pluginId: string | null }[];
  /** Anatomy Memory partition bytes. */
  memoryBytes: number;
  /** Instruction files loaded at start only. */
  instructionFiles: { path: string; bytes: number; source: 'project' | 'user' }[];
  agentTypes: { name: string; bytes: number }[];
}

export interface StartupMcpServer {
  /** `mcpKey()` of the server name. */
  key: string;
  label: string;
  /** Startup deferred names. */
  names: string[];
  namesBytes: number;
  instrBytes: number;
  /** Anatomy status `failed` or snapshot `connected === false`. */
  failed: boolean;
  /** From the snapshot; `null` = not in the snapshot. */
  configSource: 'project' | 'user' | null;
}

export interface MatchedItem {
  name: string;
  bytes: number | null;
  status?: 'connected' | 'failed';
  note?: string;
}

/** A link to the Claude Code documentation page that describes the setting. */
export interface DocLink {
  label: string;
  url: string;
}

export interface CatalogEntry {
  id: string;
  title: string;
  controller: Controller;
  explanation: string;
  disable: { text: string; snippet?: (items: MatchedItem[]) => string };
  /** Official documentation for the group and its switch, in reading order. */
  docs: DocLink[];
  /** Optional row-level note built from the row's items (e.g. "2 connectors"). */
  note?: (items: MatchedItem[]) => string;
  /** `null` or `[]` = not matched. */
  match: (f: StartupFacts) => MatchedItem[] | null;
}

export interface RecommendationRow {
  id: string;
  title: string;
  controller: Controller;
  explanation: string;
  items: MatchedItem[];
  /** Σ item bytes; `null` when every item is unmeasured. */
  bytes: number | null;
  /** `Math.round(bytes / cpt)`. */
  tokens: number | null;
  /** `tokens / denominator` (0 when the denominator is 0). */
  share: number | null;
  disableText: string;
  snippet: string | null;
  docs: DocLink[];
  /** Row-level note (`CatalogEntry.note`), `null` when the entry has none. */
  note: string | null;
}
