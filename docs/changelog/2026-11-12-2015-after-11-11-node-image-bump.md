# Docker image moves to Node.js 26.13.1

- The server image and the dev sandbox now run Node.js 26.13.1 (November 2026 security release: high-severity HTTP/2 and TLS fixes); the runtime base is pinned to `node:26.13.1-alpine3.24`.
- The docs now ask hook users for Node.js 22.23.5 / 24.22.3 / 26.13.1 or later; the hook still starts on Node.js 18.19+.
