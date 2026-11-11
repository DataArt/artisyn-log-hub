// The tool definitions of a session's first request, shared by the anatomy's "Tool definitions"
// partition and the "View system prompt" modal so both show the same tools and the same sizes.
// Rules: docs/knowledgebase/algorithms/sysctx-anatomy.md § "Tool definitions" (the modal's use:
// system-prompt-view.md rule 3).
//
// Two sources, in order:
// 1. wire — the `api-request-shape` line whose `shapeHash` is the one of the first main
//    `api-request` of the startup block: the tools array exactly as it was sent;
// 2. snapshot — the first `prompt_snapshot` attachment with a non-empty `tools` array (it is
//    usually written after the first reply, but the tool set is the same).
// A tool's size is name + description + the compact JSON of its input schema — the text the model
// reads (the JSON of the whole definition would count the description's escapes, ~2 % more). The
// snapshot keeps the whole wire definition `{name, description, input_schema, …}` in
// `tools[].schema`; an older or synthetic item has the input schema itself in `schema`. Tools with
// `defer_loading: true` are not in the context until searched and are dropped.

/** Where the tools were read from. */
export type ToolSource = 'wire' | 'snapshot';

export interface ToolDefinition {
  /** 1-based position in the source's tools array. */
  index: number;
  /** Raw name, `null` when absent or empty. */
  name: string | null;
  /** Raw description, `null` when absent or not a string. */
  description: string | null;
  /** The JSON Schema of the input (`input_schema`, else `schema`), `null` when absent. */
  inputSchema: unknown;
  /** MCP server of the tool (snapshot `server`), `null` when absent. Not counted in `bytes`. */
  server: string | null;
  /** UTF-8 bytes of the definition (see the header comment). */
  bytes: number;
}

export interface ToolDefinitions {
  source: ToolSource;
  tools: ToolDefinition[];
  bytes: number;
}

type Obj = Record<string, unknown>;

const encoder = new TextEncoder();
const utf8 = (s: string): number => encoder.encode(s).length;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sizes one tool entry of either source. */
function toolDefinition(t: unknown, i: number): ToolDefinition {
  const o: Obj = isObj(t) ? t : {};
  const name = typeof o.name === 'string' && o.name !== '' ? o.name : null;
  const description = typeof o.description === 'string' ? o.description : null;
  const server = typeof o.server === 'string' ? o.server : null;
  // The input schema: inside the snapshot's `schema` when that is the whole wire tool, a wire
  // item's own `input_schema`, else `schema` itself (an older or synthetic shape).
  const inputSchema =
    isObj(o.schema) && 'input_schema' in o.schema
      ? o.schema.input_schema
      : o.schema === undefined
        ? o.input_schema
        : o.schema;
  const schema = inputSchema ?? null;
  return {
    index: i + 1,
    name,
    description,
    inputSchema: schema,
    server,
    bytes:
      utf8(name ?? '') +
      utf8(description ?? '') +
      (schema !== null ? utf8(JSON.stringify(schema)) : 0),
  };
}

/** A deferred tool (`defer_loading: true`) is not loaded into the context until it is searched. */
function isDeferred(t: unknown): boolean {
  if (!isObj(t)) return false;
  const wire = isObj(t.schema) ? t.schema : t;
  return wire.defer_loading === true || t.defer_loading === true;
}

function fromArray(source: ToolSource, tools: unknown[]): ToolDefinitions {
  const defs = tools
    .map(toolDefinition)
    .filter((_, i) => !isDeferred(tools[i]));
  return { source, tools: defs, bytes: defs.reduce((s, d) => s + d.bytes, 0) };
}

/** The tools array of the first main request's wire shape, `null` when not logged. */
function wireTools(
  startupLines: Record<string, unknown>[],
  main: Record<string, unknown>[],
): unknown[] | null {
  const request = startupLines.find(
    (l) =>
      l.type === 'api-request' &&
      typeof l.shapeHash === 'string' &&
      (l.querySource === undefined || l.querySource === 'repl_main_thread'),
  );
  if (!request) return null;
  const shapeLine = main.find(
    (l) => l.type === 'api-request-shape' && l.shapeHash === request.shapeHash,
  );
  const shape = shapeLine?.shape;
  return isObj(shape) && Array.isArray(shape.tools) ? shape.tools : null;
}

/** The first non-sidechain `prompt_snapshot` with a non-empty `tools` array. */
function snapshotTools(main: Record<string, unknown>[]): unknown[] | null {
  for (const l of main) {
    if (l.isSidechain === true || l.type !== 'attachment') continue;
    const att = l.attachment;
    if (!isObj(att) || att.type !== 'prompt_snapshot') continue;
    if (Array.isArray(att.tools) && att.tools.length > 0) return att.tools;
  }
  return null;
}

/**
 * The first request's tool definitions: the wire shape when logged, else the tools snapshot,
 * else `null`. `startupLines` is the anatomy's startup block (sidechains removed).
 */
export function findToolDefinitions(
  startupLines: Record<string, unknown>[],
  main: Record<string, unknown>[],
): ToolDefinitions | null {
  const wire = wireTools(startupLines, main);
  if (wire && wire.length > 0) return fromArray('wire', wire);
  const snap = snapshotTools(main);
  return snap ? fromArray('snapshot', snap) : null;
}

/** `mcp__<server>__<tool>` → `<server>`, else `null`. */
export function mcpServerOfTool(name: string | null): string | null {
  const m = name ? /^mcp__(.+?)__/.exec(name) : null;
  return m ? m[1] : null;
}
