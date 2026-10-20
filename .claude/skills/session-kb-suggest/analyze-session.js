'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const sessionId = process.argv[2];

// If no session ID given, list recent sessions instead
if (!sessionId) {
  const cwd = process.cwd();
  const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const baseDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
  if (!fs.existsSync(baseDir)) {
    console.error(`No session directory found at: ${baseDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(baseDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const stat = fs.statSync(path.join(baseDir, f));
      return { sessionId: f.replace('.jsonl', ''), mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10);
  console.log(JSON.stringify({ recentSessions: files }, null, 2));
  process.exit(0);
}

const cwd = process.cwd();
const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const baseDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
const sessionFile = path.join(baseDir, `${sessionId}.jsonl`);

if (!fs.existsSync(sessionFile)) {
  const available = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', ''))
    : [];
  console.error(JSON.stringify({
    error: `Session file not found: ${sessionFile}`,
    lookedIn: baseDir,
    availableSessions: available,
  }, null, 2));
  process.exit(1);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => b.text || b.content || '').join('');
}

function parseSessionFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const userMessages = [];
  const toolCalls = [];

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === 'user' && event.message?.content) {
      const text = extractText(event.message.content).trim();
      if (text) userMessages.push(text.substring(0, 800));
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({ name: block.name, input: block.input || {} });
        }
      }
    }
  }
  return { userMessages, toolCalls };
}

const main = parseSessionFile(sessionFile);

// Include subagent tool calls — exploration often happens inside Explore agents
const subagentDir = path.join(baseDir, sessionId, 'subagents');
const allToolCalls = [...main.toolCalls];
let subagentCount = 0;

if (fs.existsSync(subagentDir)) {
  for (const f of fs.readdirSync(subagentDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const sub = parseSessionFile(path.join(subagentDir, f));
    allToolCalls.push(...sub.toolCalls);
    subagentCount++;
  }
}

// Aggregate by tool name
const toolCallCounts = {};
for (const tc of allToolCalls) {
  toolCallCounts[tc.name] = (toolCallCounts[tc.name] || 0) + 1;
}

// Files read — with frequency
const fileReadFreq = {};
for (const tc of allToolCalls) {
  if (tc.name === 'Read' && tc.input.file_path) {
    const f = tc.input.file_path;
    fileReadFreq[f] = (fileReadFreq[f] || 0) + 1;
  }
}
const filesRead = Object.entries(fileReadFreq)
  .sort((a, b) => b[1] - a[1])
  .map(([file, count]) => ({ file, count }));

// Grep searches
const grepSearches = allToolCalls
  .filter(tc => tc.name === 'Grep')
  .map(tc => ({
    pattern: tc.input.pattern || '',
    path: tc.input.path || '',
    glob: tc.input.glob || '',
    type: tc.input.type || '',
    outputMode: tc.input.output_mode || '',
  }));

// Glob searches
const globSearches = allToolCalls
  .filter(tc => tc.name === 'Glob')
  .map(tc => ({
    pattern: tc.input.pattern || '',
    path: tc.input.path || '',
  }));

// Agent invocations (main session only — subagent prompts are the key signal)
const agentCalls = main.toolCalls
  .filter(tc => tc.name === 'Agent')
  .map(tc => ({
    subagentType: tc.input.subagent_type || 'general',
    description: tc.input.description || '',
    promptSnippet: (tc.input.prompt || '').substring(0, 500),
  }));

// Bash commands (may reveal cat/find workarounds)
const bashCommands = allToolCalls
  .filter(tc => tc.name === 'Bash')
  .map(tc => (tc.input.command || '').substring(0, 200))
  .slice(0, 20);

console.log(JSON.stringify({
  sessionId,
  taskGoal: main.userMessages[0] || '(no user message found)',
  followUpMessages: main.userMessages.slice(1, 5),
  subagentCount,
  toolCallCounts,
  totalToolCalls: allToolCalls.length,
  filesRead,
  grepSearches,
  globSearches,
  agentCalls,
  bashCommands,
}, null, 2));
