#!/usr/bin/env node
// Mock stdio MCP server (newline-delimited JSON-RPC, no SDK) with four deterministic tools:
//   fast_echo  — answers at once with "fast_echo: <text>";
//   fast_fail  — answers at once with isError: true, "fast_fail: <text> failed";
//   slow_echo  — answers after MOCK_SLOW_MS (default 8000) with "slow_echo: <text>";
//   slow_fail  — answers after MOCK_SLOW_MS with isError: true, "slow_fail: <text> failed".
// No MCP `tasks` capability: backgrounding on CC >= 2.1.319 comes only from the client's
// auto-background threshold (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS), which works for any server.
// Every JSON-RPC message is appended to raw/mcp-traffic.log.
'use strict';

const fs = require('fs');
const path = require('path');

const SLOW_MS = Number(process.env.MOCK_SLOW_MS || 8000);
const rawDir = path.join(__dirname, 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const logFile = path.join(rawDir, 'mcp-traffic.log');

function log(dir, msg) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${dir} ${JSON.stringify(msg)}\n`);
}

function send(msg) {
  log('OUT', msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const TOOLS = {
  fast_echo: { delay: 0, fail: false },
  fast_fail: { delay: 0, fail: true },
  slow_echo: { delay: SLOW_MS, fail: false },
  slow_fail: { delay: SLOW_MS, fail: true },
};

function toolDef(name) {
  const t = TOOLS[name];
  return {
    name,
    description: `${t.delay ? `Waits ${t.delay} ms, then ` : 'At once '}${t.fail ? 'fails' : 'echoes the text back'}.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  };
}

function callResult(name, args) {
  const text = args && typeof args.text === 'string' ? args.text : '';
  const t = TOOLS[name];
  return t.fail
    ? { isError: true, content: [{ type: 'text', text: `${name}: ${text} failed` }] }
    : { content: [{ type: 'text', text: `${name}: ${text}` }] };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification needs no answer
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock', version: '0.0.1' },
    } });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: Object.keys(TOOLS).map(toolDef) } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS[name]) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }
    const reply = () => send({ jsonrpc: '2.0', id, result: callResult(name, params.arguments) });
    if (TOOLS[name].delay) setTimeout(reply, TOOLS[name].delay); else reply();
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('BAD', line); continue; }
    log('IN', msg);
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
