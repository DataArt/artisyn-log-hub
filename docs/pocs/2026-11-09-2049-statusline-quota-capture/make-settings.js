#!/usr/bin/env node
'use strict';
// Writes claude-config/settings.json with a statusLine pointing at this PoC's
// capture script (absolute path derived at runtime, so nothing machine-specific
// is committed). Use it with: claude --settings claude-config/settings.json

const fs = require('fs');
const path = require('path');

const script = path.join(__dirname, 'capture-statusline.js').replace(/\\/g, '/');
const dir = path.join(__dirname, 'claude-config');
fs.mkdirSync(dir, { recursive: true });
const settings = { statusLine: { type: 'command', command: `node "${script}"` } };
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
console.log(path.join(dir, 'settings.json'));
