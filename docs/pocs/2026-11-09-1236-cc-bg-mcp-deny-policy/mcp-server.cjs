#!/usr/bin/env node
// Minimal stdio MCP server (newline-delimited JSON-RPC, no SDK) exposing one tool `slow_echo`.
// The tool declares `execution.taskSupport: "optional"` and the server advertises the MCP
// `tasks` capability, so a client that supports MCP tasks (Claude Code >= 2.1.319) can run the
// call as a task: tools/call returns a CreateTaskResult at once, the client polls tasks/get and
// fetches the real CallToolResult with tasks/result. Without `params.task` the call is answered
// synchronously after the sleep. Every message in/out is appended to raw/mcp-traffic.log.
// SLOW_ECHO_MS (default 8000) sets the sleep; POC_MCP_NO_TASKS=1 drops the tasks capability.
'use strict';

const fs = require('fs');
const path = require('path');

const SLEEP_MS = Number(process.env.SLOW_ECHO_MS || 8000);
const NO_TASKS = process.env.POC_MCP_NO_TASKS === '1';
const logDir = path.join(__dirname, 'raw');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'mcp-traffic.log');

function log(dir, msg) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${dir} ${JSON.stringify(msg)}\n`);
}

function send(msg) {
  log('OUT', msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const tasks = new Map();
let taskSeq = 0;

function taskView(t) {
  return {
    taskId: t.taskId,
    status: t.status,
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    ttl: t.ttl,
    pollInterval: 1000,
  };
}

function echoResult(args) {
  return { content: [{ type: 'text', text: `slow_echo says: ${args && args.text} (after ${SLEEP_MS} ms)` }] };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === 'initialize') {
    const capabilities = { tools: {} };
    if (!NO_TASKS) capabilities.tasks = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-11-25',
      capabilities,
      serverInfo: { name: 'poc', version: '0.0.1' },
    } });
    return;
  }
  if (method === 'tools/list') {
    const tool = {
      name: 'slow_echo',
      description: 'Sleeps a few seconds, then echoes the text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    };
    if (!NO_TASKS) tool.execution = { taskSupport: 'optional' };
    send({ jsonrpc: '2.0', id, result: { tools: [tool] } });
    return;
  }
  if (method === 'tools/call') {
    const args = params && params.arguments;
    if (params && params.task && !NO_TASKS) {
      const now = new Date().toISOString();
      const t = { taskId: `task-${++taskSeq}`, status: 'working', createdAt: now, lastUpdatedAt: now,
        ttl: params.task.ttl || 60000, result: null, waiters: [] };
      tasks.set(t.taskId, t);
      setTimeout(() => {
        t.status = 'completed';
        t.lastUpdatedAt = new Date().toISOString();
        t.result = echoResult(args);
        send({ jsonrpc: '2.0', method: 'notifications/tasks/status', params: taskView(t) });
        t.waiters.forEach((w) => w());
      }, SLEEP_MS);
      send({ jsonrpc: '2.0', id, result: { task: taskView(t) } });
      return;
    }
    setTimeout(() => send({ jsonrpc: '2.0', id, result: echoResult(args) }), SLEEP_MS);
    return;
  }
  if (method === 'tasks/get') {
    const t = tasks.get(params && params.taskId);
    if (!t) { send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown task' } }); return; }
    send({ jsonrpc: '2.0', id, result: taskView(t) });
    return;
  }
  if (method === 'tasks/result') {
    const t = tasks.get(params && params.taskId);
    if (!t) { send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown task' } }); return; }
    const reply = () => send({ jsonrpc: '2.0', id, result: { ...t.result,
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: t.taskId } } } });
    if (t.result) reply(); else t.waiters.push(reply);
    return;
  }
  if (method === 'tasks/list') {
    send({ jsonrpc: '2.0', id, result: { tasks: [...tasks.values()].map(taskView) } });
    return;
  }
  if (method === 'tasks/cancel') {
    const t = tasks.get(params && params.taskId);
    if (t) { t.status = 'cancelled'; t.lastUpdatedAt = new Date().toISOString(); }
    send({ jsonrpc: '2.0', id, result: t ? taskView(t) : {} });
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
    try { msg = JSON.parse(line); } catch (e) { log('BAD', line); continue; }
    log('IN', msg);
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
