#!/usr/bin/env node
/**
 * Claude Code Guardrail Hook
 * Blocks file reads and writes outside the project directory and
 * access to explicitly prohibited files.
 * Also evaluates Bash tool calls via LLM when enabled.
 *
 * Configuration (in .claude/telemetry_tool/.env):
 *   GUARDRAIL_ENABLED=true|false          — set to "false" to disable (default: enabled)
 *   GUARDRAIL_PROHIBITED_FILES=a,b,...    — comma-separated paths relative to project root
 *                                           that are always blocked regardless of location
 *   GUARDRAIL_LLM_ENABLED=true|false      — enable LLM checks for Bash tool (default: false)
 *   GUARDRAIL_LLM_MODEL=haiku             — Claude model for LLM checks (default: haiku)
 *   GUARDRAIL_LLM_TIMEOUT_MS=10000        — timeout for LLM calls in ms (default: 10000)
 *   GUARDRAIL_BLOCK_NETWORK=true|false    — block network access in Bash commands (default: false)
 *                                           Note: WebFetch/WebSearch are not blockable via hooks;
 *                                           use permissions.deny in settings.json for those.
 *
 * Checked tools: Read, Write, Edit, Glob (static), Bash (LLM)
 *
 * Blocking behaviour (Claude Code 2.x):
 *   Exit 0 + JSON stdout (permissionDecision: "deny") → tool call is blocked
 *   Exit 0 + no/other stdout                         → tool call proceeds normally
 *   Non-zero + stderr                                → hook error, non-blocking
 *
 * Windows note: use process.exitCode + natural exit (not process.exit()) for blocking
 *   so that stdout is flushed before the process terminates.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
let hookLog;
try {
    ({ hookLog } = require('./hook-log'));
} catch {
    hookLog = () => {}; // no-op if hook-log.js is missing
}

const HOOK_FILE = 'guardrail-hook.js';

// Tools whose file-path arguments are subject to static guardrail checks
const STATIC_CHECKED_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob']);

// Convert WSL-style paths (/mnt/x/...) to Windows paths (X:\...) so that
// comparisons work when Node runs on Windows but Claude passes /mnt/ paths.
function wslToWindows(filePath) {
    const m = filePath.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
    if (m) {
        const drive = m[1].toUpperCase();
        const rest = (m[2] || '').replace(/\//g, '\\');
        return `${drive}:${rest || '\\'}`;
    }
    return filePath;
}

// Convert Git-Bash-style paths (/d/foo/bar) to Windows paths (D:\foo\bar).
function gitBashToWindows(filePath) {
    const m = filePath.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) {
        const drive = m[1].toUpperCase();
        const rest = (m[2] || '').replace(/\//g, '\\');
        return `${drive}:${rest || '\\'}`;
    }
    return filePath;
}

// Return all known representations of a Windows absolute path so that LLM
// prompts list every variant (Windows, WSL /mnt/x/..., Git Bash /x/...).
function windowsPathVariants(winPath) {
    // winPath expected to be already normalised, e.g. D:\foo\bar
    const m = winPath.match(/^([A-Z]):\\(.*)$/);
    if (!m) return [winPath];
    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, '/');
    const unix = rest ? `/${drive}/${rest}` : `/${drive}`;
    const wsl = rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
    return [winPath, unix, wsl];
}

function resolveAbs(filePath, base) {
    const normalized = gitBashToWindows(wslToWindows(filePath));
    return path.normalize(
        path.isAbsolute(normalized) ? normalized : path.resolve(base, normalized)
    );
}


function isWithinDir(absFile, absDir) {
    const rel = path.relative(absDir, absFile);
    // rel === '' means absFile IS the directory itself — allow it
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Return the path-like argument from the tool input, or null if there is none.
function extractPath(toolName, toolInput) {
    if (!toolInput) return null;
    // Read / Write / Edit all use "file_path"
    if (toolInput.file_path) return toolInput.file_path;
    // Glob uses optional "path" (the search root directory)
    if (toolName === 'Glob' && toolInput.path) return toolInput.path;
    return null;
}

// Write a block decision to stdout (exit 0 + JSON — Claude Code 2.x format).
// Uses natural process exit so stdout is flushed before termination on Windows.
function writeBlock(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}

// Resolve the claude executable name for the current platform.
// Fail-open: returns 'claude' on any error.
function resolveClaude() {
    try {
        if (process.platform === 'win32') {
            const result = spawnSync('where', ['claude.cmd'], { encoding: 'utf8' });
            if (result.status === 0 && result.stdout.trim()) {
                return 'claude.cmd';
            }
            return 'claude';
        }
        return 'claude';
    } catch {
        return 'claude';
    }
}

/**
 * Invoke claude --print with a prompt via stdin.
 * Uses --output-format json to capture the spawned session ID, then writes a
 * hook_service marker to the artisyn telemetry so the server can identify and
 * filter these sessions without relying on prompt content.
 *
 * Returns the LLM text response, or null on failure.
 */
function callLlm(prompt, model, timeoutMs, claudeBin, telemetryDir, writeTelemetryFn) {
    const result = spawnSync(
        claudeBin,
        ['--model', model, '--print', '--no-session-persistence', '--output-format', 'json'],
        {
            encoding: 'utf8',
            input: prompt,
            timeout: timeoutMs,
            shell: process.platform === 'win32',
        }
    );
    if (result.error && (result.error.code === 'ETIMEDOUT' || result.status === null)) {
        const msg = 'LLM call timed out';
        process.stderr.write(`guardrail-hook LLM warning: ${msg}\n`);
        hookLog(HOOK_FILE, null, 'error', msg, null);
        return null;
    }
    if (result.status !== 0) {
        const msg = `LLM call exited with status ${result.status}`;
        process.stderr.write(`guardrail-hook LLM warning: ${msg}\n`);
        hookLog(HOOK_FILE, null, 'error', msg, null);
        return null;
    }

    const raw = (result.stdout || '').trim();

    // Parse --output-format json envelope to get the session ID and the actual text.
    // Falls back to treating stdout as plain text for older Claude Code versions.
    let text = raw;
    let spawnedSessionId = null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.result === 'string') {
            text = parsed.result;
            spawnedSessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
        }
    } catch {
        // plain-text fallback — session ID unknown, no marker written
    }

    // Tag the spawned session as a hook-service session in the artisyn telemetry.
    // The server detects this event via JSONB query and sets isHookService = true.
    if (spawnedSessionId && telemetryDir && writeTelemetryFn) {
        try {
            writeTelemetryFn({
                type: 'artisyn',
                event: 'hook_service',
                hook_service_type: 'guardrail',
                timestamp: new Date().toISOString(),
                session_id: spawnedSessionId,
            }, telemetryDir);
        } catch {
            // telemetry failures must never affect guardrail behaviour
        }
    }

    return text;
}

// Pass 1 — ask the LLM to list files referenced by the bash command.
// Returns an array of path strings, or null on failure (fail-open).
function extractReferencedFiles(bashCommand, model, timeoutMs, claudeBin, telemetryDir, writeTelemetryFn) {
    const prompt = [
        'Analyze the following bash command and list every file path it references — including',
        'scripts it runs (e.g. node foo.js), files it reads (e.g. cat file.txt), source files,',
        'config files, and any path that appears as an argument.',
        '',
        'Bash command:',
        '```',
        bashCommand,
        '```',
        '',
        'Respond ONLY with a JSON array of file path strings, e.g. ["foo.js", "/tmp/bar.txt"].',
        'If no files are referenced respond with [].',
        'No markdown, no explanation — just the JSON array.',
        'IMPORTANT: Your response must be valid JSON. Escape all backslashes as \\\\ (e.g. "C:\\\\Users\\\\foo").',
    ].join('\n');

    const output = callLlm(prompt, model, timeoutMs, claudeBin, telemetryDir, writeTelemetryFn);
    if (output === null) return null;
    try {
        const match = output.match(/\[[\s\S]*\]/);
        if (!match) return [];
        return JSON.parse(match[0]);
    } catch {
        const msg = 'LLM file-list response is not valid JSON';
        process.stderr.write(`guardrail-hook LLM warning: ${msg}\n`);
        hookLog(HOOK_FILE, null, 'error', msg, null);
        return null;
    }
}

// Build the security-analysis prompt (pass 2).
function buildAnalysisPrompt(bashCommand, activeChecks, fileContents) {
    const lines = [
        'You are a security guardrail. Evaluate the following bash command and determine if it should be blocked.',
        '',
        'Bash command to evaluate:',
        '```',
        bashCommand,
        '```',
        '',
    ];

    if (fileContents.length > 0) {
        lines.push('Contents of files referenced by the command:');
        for (const { filePath, content } of fileContents) {
            lines.push(`\n--- ${filePath} ---`);
            lines.push('```');
            lines.push(content);
            lines.push('```');
        }
        lines.push('');
    }

    lines.push('Active security checks:');

    if (activeChecks.prohibitedFiles.length > 0) {
        lines.push('1. PROHIBITED FILES: Block if the command or any referenced file accesses:');
        for (const f of activeChecks.prohibitedFiles) {
            lines.push(`   - ${path.normalize(f)}`);
        }
    }

    if (activeChecks.projectRoot !== null) {
        const rootVariants = windowsPathVariants(path.normalize(activeChecks.projectRoot));
        lines.push('2. PROJECT BOUNDARY: Block if the command or any referenced file accesses paths outside the project root.');
        lines.push('   The project root in all equivalent path formats:');
        for (const v of rootVariants) {
            lines.push(`   - ${v}`);
        }
        lines.push('   Treat /x/foo, /mnt/x/foo, and X:\\foo as the same path (x = drive letter).');
    }

    if (activeChecks.blockNetwork) {
        lines.push('3. NETWORK ACCESS: Block if the command or any referenced file makes network requests (curl, wget, ssh, nc, nmap, etc.).');
    }

    lines.push(
        '',
        'Rules:',
        '- Analyze both the command string and the contents of any referenced files.',
        '- The first matching violation determines the "reason".',
        '- If multiple checks are active, check in this order: prohibited_file, outside_project, network_access.',
        '',
        'Respond ONLY with a JSON object in this exact format (no markdown, no explanation outside the JSON):',
        '{ "block": boolean, "reason": "prohibited_file"|"outside_project"|"network_access"|null, "explanation": string }',
        '',
        'Where:',
        '  "block" is true if the command should be blocked, false otherwise.',
        '  "reason" is the first matching violation, or null if not blocked.',
        '  "explanation" is a brief human-readable explanation — do NOT include file paths or backslashes.',
        'IMPORTANT: Your response must be valid JSON. Do not use backslashes in the explanation field.',
    );

    return lines.join('\n');
}

// Run two-pass LLM check. Returns block decision or null on failure (fail-open).
function runLlmCheck(bashCommand, activeChecks, model, timeoutMs, claudeBin, projectDir, maxScriptBytes, telemetryDir, writeTelemetryFn) {
    // Pass 1: get the list of files referenced by the command
    const referencedFiles = extractReferencedFiles(bashCommand, model, timeoutMs, claudeBin, telemetryDir, writeTelemetryFn);
    if (referencedFiles === null) return null; // fail-open on LLM error

    // For each file: block if outside project or too large; read if inside and within size limit
    const fileContents = [];
    for (const rawPath of referencedFiles) {
        const absPath = resolveAbs(rawPath, projectDir);

        if (!isWithinDir(absPath, projectDir)) {
            // File is outside project root — block immediately without reading
            return {
                block: true,
                reason: 'outside_project',
                explanation: `Command references a file outside the project root: "${rawPath}"`,
            };
        }

        try {
            const stat = fs.statSync(absPath);
            if (stat.size > maxScriptBytes) {
                return {
                    block: true,
                    reason: 'outside_project',
                    explanation: `Referenced file "${rawPath}" exceeds the maximum allowed size (${Math.round(maxScriptBytes / 1024)} KB) and cannot be analysed — blocked for safety.`,
                };
            }
            const content = fs.readFileSync(absPath, 'utf8');
            fileContents.push({ filePath: absPath, content });
        } catch {
            // File not readable (doesn't exist, permission denied, etc.) — skip it
        }
    }

    // Pass 2: analyse command + file contents against security checks
    const prompt = buildAnalysisPrompt(bashCommand, activeChecks, fileContents);
    const output = callLlm(prompt, model, timeoutMs, claudeBin, telemetryDir, writeTelemetryFn);
    if (output === null) return null;

    try {
        const match = output.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('no JSON found');
        return JSON.parse(match[0]);
    } catch {
        const msg = 'LLM analysis response is not valid JSON';
        process.stderr.write(`guardrail-hook LLM warning: ${msg}\n`);
        hookLog(HOOK_FILE, null, 'error', msg, null);
        return null;
    }
}

try {
    const {loadEnvWithLocal, resolveTelemetryDir, getEnvContext, isCompactJson} = require('./env-context');
    const {writeTelemetry} = require('./write-telemetry');
    const {getGitRoot} = require('./git-context');

    // IIFE so `return` can be used for early exits.
    (function () {
        let input = {};
        if (!process.stdin.isTTY) {
            try {
                const raw = fs.readFileSync(process.stdin.fd, 'utf8');
                input = raw.trim() ? JSON.parse(raw) : {};
            } catch {
                // malformed or empty stdin — pass through
            }
        }

        // Only act on PreToolUse events for checked tools
        if (input.hook_event_name !== 'PreToolUse') return;
        const toolName = input.tool_name || '';
        const isStaticTool = STATIC_CHECKED_TOOLS.has(toolName);
        const isBashTool = toolName === 'Bash';
        if (!isStaticTool && !isBashTool) return;

        const sessionId = input.session_id || null;
        const cwd = input.cwd || process.cwd();
        hookLog(HOOK_FILE, sessionId, 'activate', `PreToolUse tool=${toolName}`, cwd);

        const envVars = loadEnvWithLocal(path.join(__dirname, '.env'));

        // Allow opt-out via GUARDRAIL_ENABLED=false
        if ((envVars.GUARDRAIL_ENABLED || 'true').trim().toLowerCase() === 'false') return;

        // Use git repo root as the project boundary so that sessions opened in a
        // subdirectory (e.g. hook/) still enforce the top-level repo root.
        const projectDir = getGitRoot(cwd);

        // Resolve prohibited file list (absolute paths)
        const rawProhibited = (envVars.GUARDRAIL_PROHIBITED_FILES || '').trim();
        const prohibitedFiles = rawProhibited
            ? rawProhibited
                  .split(',')
                  .map(p => p.trim())
                  .filter(Boolean)
                  .map(p => path.normalize(path.resolve(projectDir, p)))
            : [];

        // Shared telemetry setup (used only on block)
        const telemetryDir = resolveTelemetryDir(cwd, envVars);
        const context = getEnvContext(envVars);
        const compact = isCompactJson(envVars);
        const base = {
            timestamp: new Date().toISOString(),
            session_id: input.session_id || null,
            ...(context ? {context} : {}),
        };

        if (isStaticTool) {
            const targetPath = extractPath(toolName, input.tool_input);
            if (!targetPath) return;

            const absTarget = resolveAbs(targetPath, cwd);

            function logBlock(reason) {
                try {
                    writeTelemetry({
                        event: 'guardrail_block',
                        ...base,
                        tool_name: toolName,
                        file_path: targetPath,
                        reason,
                        project_dir: projectDir,
                    }, telemetryDir, compact);
                } catch {
                    // telemetry failure must never affect blocking behaviour
                }
            }

            // 1. Prohibited-file check (takes priority; shows a specific message)
            for (const prohibited of prohibitedFiles) {
                if (absTarget === prohibited) {
                    logBlock('prohibited_file');
                    hookLog(HOOK_FILE, sessionId, 'result', `blocked tool=${toolName} reason=prohibited_file path="${targetPath}"`, cwd);
                    writeBlock(`BLOCKED by guardrail: "${targetPath}" is a prohibited file and cannot be accessed.`);
                    return;
                }
            }

            // 2. Project-boundary check (controlled by GUARDRAIL_BLOCK_OUTSIDE_PROJECT)
            const blockOutside = (envVars.GUARDRAIL_BLOCK_OUTSIDE_PROJECT || 'true').trim().toLowerCase() !== 'false';
            if (blockOutside && !isWithinDir(absTarget, projectDir)) {
                logBlock('outside_project');
                hookLog(HOOK_FILE, sessionId, 'result', `blocked tool=${toolName} reason=outside_project path="${targetPath}"`, cwd);
                writeBlock(
                    `BLOCKED by guardrail: "${targetPath}" is outside the allowed project directory ` +
                    `"${projectDir}". File access is restricted to the project root.`
                );
                return;
            }
            hookLog(HOOK_FILE, sessionId, 'result', `allowed tool=${toolName} path="${targetPath}"`, cwd);
        }

        if (isBashTool) {
            const bashCommand = ((input.tool_input || {}).command || '').trim();
            if (!bashCommand) return;

            const llmEnabled = (envVars.GUARDRAIL_LLM_ENABLED || 'false').trim().toLowerCase();
            if (llmEnabled !== 'true') return;

            const model = (envVars.GUARDRAIL_LLM_MODEL || 'haiku').trim();
            const timeoutMs = parseInt(envVars.GUARDRAIL_LLM_TIMEOUT_MS || '10000', 10);
            const maxScriptKb = parseInt(envVars.GUARDRAIL_MAX_SCRIPT_SIZE_KB || '10', 10);
            const maxScriptBytes = maxScriptKb * 1024;
            const blockNetwork = (envVars.GUARDRAIL_BLOCK_NETWORK || 'false').trim().toLowerCase() === 'true';
            const blockOutside = (envVars.GUARDRAIL_BLOCK_OUTSIDE_PROJECT || 'true').trim().toLowerCase() !== 'false';

            // Build active checks — apply wslToWindows + gitBashToWindows + normalize to prohibited file paths
            const resolvedProhibited = prohibitedFiles.map(p => path.normalize(gitBashToWindows(wslToWindows(p))));
            const activeChecks = {
                prohibitedFiles: resolvedProhibited,
                projectRoot: blockOutside ? projectDir : null,
                blockNetwork,
            };

            // Skip LLM call if no active checks
            if (activeChecks.prohibitedFiles.length === 0 && activeChecks.projectRoot === null && !activeChecks.blockNetwork) {
                return;
            }

            const claudeBin = resolveClaude();
            const llmResult = runLlmCheck(bashCommand, activeChecks, model, timeoutMs, claudeBin, projectDir, maxScriptBytes, telemetryDir, writeTelemetry);

            // Fail-open: null means LLM error
            if (llmResult === null) return;

            if (llmResult.block === true) {
                const reasonMap = {
                    'prohibited_file': 'llm_prohibited_file',
                    'outside_project': 'llm_outside_project',
                    'network_access': 'llm_network_access',
                };
                const telemetryReason = reasonMap[llmResult.reason] || 'llm_block';

                try {
                    writeTelemetry({
                        event: 'guardrail_block',
                        ...base,
                        tool_name: toolName,
                        reason: telemetryReason,
                        project_dir: projectDir,
                    }, telemetryDir, compact);
                } catch {
                    // telemetry failure must never affect blocking behaviour
                }

                hookLog(HOOK_FILE, sessionId, 'result', `blocked tool=Bash reason=${telemetryReason}`, cwd);
                writeBlock(llmResult.explanation);
            } else {
                hookLog(HOOK_FILE, sessionId, 'result', 'allowed tool=Bash (llm check passed)', cwd);
            }
        }
    })();
} catch (err) {
    hookLog(HOOK_FILE, null, 'error', err.message, null);
    process.stderr.write(`guardrail-hook error: ${err.message}\n`);
    process.exit(0); // never block Claude Code on unexpected errors
}
