/**
 * Tools/MCP monitoring — recognition of monitored CLI tools in an agent's shell command (FR-4
 * fallback; impl-plan DD-12).
 *
 * Used for transcript-only calls (no wrapper record) and for matching wrapper records to the
 * Bash / PowerShell `tool_use` that ran them.
 *
 * - Bash: the command is parsed with tree-sitter-bash (the parser is handed in, as
 *   `getServerBashParser()` resolves it). Every `command` node counts, nested ones included
 *   (pipelines, lists, subshells, substitutions); its `name` is the command word and its
 *   `argument`s are the arguments, unquoted when literal, else as written. A `null` parser, or a
 *   parse failure, falls back to the tokenizer below.
 * - PowerShell: the command is split into simple commands on `;`, `|`, `&&`, `||` and newlines
 *   outside quotes, then each is tokenised on whitespace honouring `'…'` / `"…"` quotes. A
 *   leading call operator `&` and leading `NAME=value` assignments are dropped.
 * - A simple command matches when its command word equals a recognised tool name, compared
 *   case-insensitively without a trailing `.exe` / `.cmd` / `.bat` / `.ps1`. A command word with
 *   a path (`./zz`, `/usr/bin/find`, `C:\x\zz.exe`) is not recognised, nor are `npx`, aliases or
 *   functions.
 * - `operation` = the first argument not starting with `-`, else `(none)`.
 *
 * Pure: no DB, no Nest.
 */
import {
  literal,
  withTree,
  type BashParser,
  type BashSyntaxNode,
} from '@loghub/bash-view';
import { normalizeToolName } from '@loghub/tool-monitor';
import type { ToolCallShell } from '../../database/schema/index';

/** One monitored tool invocation found in a command. */
export interface RecognizedCliCall {
  /** The tool name as spelled in `toolNames`. */
  tool: string;
  operation: string;
  args: string[];
}

/** `operation` of a call with no non-flag argument. */
export const NO_OPERATION = '(none)';

/** A simple command: its command word and its arguments. */
interface SimpleCommand {
  word: string;
  args: string[];
}

/** The operation of an argument list: first argument not starting with `-`. */
export function operationOfArgs(args: readonly string[]): string {
  return args.find((a) => a !== '' && !a.startsWith('-')) ?? NO_OPERATION;
}

/** A word's literal value (quotes removed), else its source text. */
function wordText(node: BashSyntaxNode): string {
  // `command_name` wraps the actual word / string node.
  const target =
    node.type === 'command_name' && node.namedChildren.length === 1
      ? node.namedChildren[0]
      : node;
  return literal(target, {}) ?? target.text;
}

function bashSimpleCommands(
  parser: BashParser,
  command: string,
): SimpleCommand[] {
  return withTree(parser, command, (root) => {
    const out: SimpleCommand[] = [];
    for (const node of root.descendantsOfType('command')) {
      const name = node.childForFieldName('name');
      if (name === null) continue;
      const word = wordText(name).trim();
      if (word === '') continue;
      out.push({
        word,
        args: node.childrenForFieldName('argument').map(wordText),
      });
    }
    return out;
  });
}

/**
 * Splits a command line into simple commands on `;`, `|`, `&&`, `||` and newlines outside
 * quotes, and tokenises each on whitespace, honouring `'…'` and `"…"` quotes (removed).
 */
export function tokenizeSimpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  const endToken = () => {
    if (inToken) tokens.push(token);
    token = '';
    inToken = false;
  };
  const endCommand = () => {
    endToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|') {
      endCommand();
      if (ch === '|' && command[i + 1] === '|') i++;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      endCommand();
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      endToken();
      continue;
    }
    token += ch;
    inToken = true;
  }
  endCommand();
  return commands;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenizedSimpleCommands(command: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  for (const tokens of tokenizeSimpleCommands(command)) {
    let start = tokens[0] === '&' ? 1 : 0;
    // Leading `NAME=value` prefixes (Bash env assignments) are not the command word.
    while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start])) start++;
    const words = tokens.slice(start);
    if (words.length === 0 || words[0] === '') continue;
    out.push({ word: words[0], args: words.slice(1) });
  }
  return out;
}

/** The simple commands of a shell command line, per the shell's rules above. */
function simpleCommands(
  parser: BashParser | null,
  command: string,
  shell: ToolCallShell,
): SimpleCommand[] {
  if (shell === 'bash' && parser !== null) {
    try {
      return bashSimpleCommands(parser, command);
    } catch {
      // Fall through to the tokenizer.
    }
  }
  return tokenizedSimpleCommands(command);
}

/** The recognisable form of a command word, or null when it carries a path. */
function commandWordKey(word: string): string | null {
  if (/[\\/]/.test(word)) return null;
  return normalizeToolName(word);
}

/** Every command word of a command line (normalised, path-less words only). */
export function commandWordsOf(
  parser: BashParser | null,
  command: string,
  shell: ToolCallShell,
): string[] {
  return simpleCommands(parser, command, shell)
    .map((c) => commandWordKey(c.word))
    .filter((w): w is string => w !== null && w !== '');
}

/**
 * The monitored tool invocations of one shell command, in source order. `toolNames` are the
 * recognised tool names (enabled monitored names ∪ names present in wrapper records).
 */
export function recognizeCliCalls(
  parser: BashParser | null,
  command: string,
  shell: ToolCallShell,
  toolNames: readonly string[],
): RecognizedCliCall[] {
  if (command.trim() === '' || toolNames.length === 0) return [];
  const byKey = new Map<string, string>();
  for (const name of toolNames) {
    const key = normalizeToolName(name);
    if (key !== '' && !byKey.has(key)) byKey.set(key, name);
  }

  const out: RecognizedCliCall[] = [];
  for (const sc of simpleCommands(parser, command, shell)) {
    const key = commandWordKey(sc.word);
    const tool = key === null ? undefined : byKey.get(key);
    if (tool === undefined) continue;
    out.push({ tool, operation: operationOfArgs(sc.args), args: sc.args });
  }
  return out;
}
