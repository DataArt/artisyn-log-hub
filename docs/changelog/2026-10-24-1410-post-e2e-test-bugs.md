# Hook works in ESM projects; installer checks the hooks start

- The hook no longer crashes (and silently records nothing) in projects whose `package.json` says `"type": "module"`; it runs on any current Node.js LTS release.
- After installing or upgrading, the installer starts every hook once the way Claude Code will and reports "not working yet" with the reason instead of "ready to use" when one cannot start.
