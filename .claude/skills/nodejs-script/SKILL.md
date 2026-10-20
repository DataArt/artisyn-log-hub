---
name: nodejs-script
description: "Always use this skill when writing, editing, or reviewing any Node.js script in this project."
---

Review or write the Node.js script using these conventions:

## Module System

Use CommonJS. Never use ESM (`import`/`export`).

```js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
```

## Sync over Async

This is a CLI hook — keep everything synchronous. Do not use `async/await`, Promises, or callbacks.

- File I/O: `fs.readFileSync`, `fs.writeFileSync`, `fs.mkdirSync`
- Subprocesses: `execFileSync` or `spawnSync` (never `exec`, `execFile`, `spawn`)
- stdin: `fs.readFileSync('/dev/stdin', 'utf8')` or `process.stdin.fd`

## No External Dependencies

Use only Node.js built-ins: `fs`, `path`, `crypto`, `child_process`, `os`, `util`.
If a utility is needed (e.g. `.env` parsing, arg parsing), write a small inline function.

## Code Style (matches ESLint config)

- Single quotes for strings
- Semicolons required
- `const` by default; `let` only when reassigned; never `var`
- Strict equality: `===` / `!==`
- 2-space indentation

## stdin Handling (for Claude Code hooks)

Hook scripts receive event data via stdin as JSON:

```js
const raw = fs.readFileSync(process.stdin.fd, 'utf8');
const event = JSON.parse(raw);
```

Wrap in try/catch — stdin may be empty or malformed.

## Exit Codes

- `process.exit(0)` — success
- `process.exit(1)` — unrecoverable error
- `process.exit(2)` — block the action (for PreToolUse hooks that want to prevent tool execution)

Prefer explicit exits over falling off the end of the script.

## Logging

Write diagnostics to **stderr**, not stdout (stdout may be parsed by the harness):

```js
process.stderr.write('Error: ...\n');
```

Use `console.error()` only if you're sure the harness ignores stderr.

## Path Handling

Always use `path.join()` / `path.resolve()`. Never concatenate paths with string `+`.

```js
const dir = path.resolve(__dirname, '../telemetry');
const file = path.join(dir, `${Date.now()}.json`);
```

## Subprocess Calls

Use `execFileSync` with an array of args, never `execSync` with a shell string (avoids injection):

```js
const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  encoding: 'utf8',
  timeout: 2000,
}).trim();
```

Wrap in try/catch — the command may not exist or may fail.

## Error Handling

Top-level scripts should have a single try/catch guard:

```js
try {
  const raw = fs.readFileSync(process.stdin.fd, 'utf8');
  // ... main logic ...
  process.exit(0);
} catch (err) {
  process.stderr.write(`telemetry-hook error: ${err.message}\n`);
  process.exit(1);
}
```

Do not silently swallow errors inside helper functions — let them propagate to the top-level catch.

## File Writing

Always ensure the output directory exists before writing:

```js
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
```

## Environment Variables

Read from `process.env` or parse a `.env` file inline. Never use `dotenv` package.

Simple inline `.env` parser:

```js
function loadEnv(envPath) {
  try {
    const vars = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}
```

## After Changes

Run lint and fix before finishing:

```sh
npm run lint:fix
npm run lint
```
