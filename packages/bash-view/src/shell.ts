/**
 * One entry point for both shell tools: which shell a tool name is, and the view / analysis of a
 * command of either shell. Bash goes to `bash-view.ts` / `bash-analyze.ts`, PowerShell to
 * `ps-view.ts` / `ps-analyze.ts`; both return the same shapes.
 */
import { type BashAnalysis, analyzeBash } from './bash-analyze.ts';
import { type BashView, buildBashView } from './bash-view.ts';
import { analyzePowerShell } from './ps-analyze.ts';
import { buildPowerShellView } from './ps-view.ts';
import { stripLhWrap } from './ps-wrap.ts';
import type { BashParser } from './syntax.ts';

export type ShellKind = 'bash' | 'powershell';

/** The shell of a tool call: `Bash` → `bash`, `PowerShell` → `powershell`, anything else → null. */
export function shellOfTool(toolName: string): ShellKind | null {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'PowerShell') return 'powershell';
  return null;
}

/** A loaded parser per shell; null when that grammar could not be loaded. */
export interface ShellParsers {
  bash: BashParser | null;
  powershell: BashParser | null;
}

/** The command view of `command` in `shell`, built with that shell's parser. */
export function buildShellView(
  shell: ShellKind,
  parser: BashParser,
  command: string,
  root: string | null | undefined,
): BashView {
  return shell === 'powershell'
    ? buildPowerShellView(parser, command, root)
    : buildBashView(parser, command, root);
}

/**
 * The FILES analysis of a shell tool call; null when `toolName` is not a shell tool, its parser
 * is null, the command is blank, or the analysis throws. A PowerShell command is analysed without
 * the hook's wrap prefix, like its view.
 */
export function analyzeShellCommand(
  parsers: ShellParsers,
  toolName: string,
  command: string,
): BashAnalysis | null {
  const shell = shellOfTool(toolName);
  if (shell === null || !command.trim()) return null;
  const parser = parsers[shell];
  if (!parser) return null;
  try {
    return shell === 'powershell'
      ? analyzePowerShell(parser, stripLhWrap(parser, command))
      : analyzeBash(parser, command);
  } catch {
    return null;
  }
}
