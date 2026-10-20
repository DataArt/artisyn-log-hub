#!/usr/bin/env node
// Removes dist/ contents; falls back to clearing contents when dir is locked (Windows EBUSY)
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'EBUSY') throw e;
  // Directory is held open (e.g. by VS Code watcher); remove contents instead
  if (fs.existsSync(distDir)) {
    for (const entry of fs.readdirSync(distDir)) {
      try {
        fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
      } catch (_) {}
    }
  }
}
