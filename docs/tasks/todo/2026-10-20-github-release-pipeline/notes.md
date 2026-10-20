# Notes — 2026-10-20 GitHub Release Pipeline

## 2026-10-20

FR-5 "about 20 s" check-budget measurement (warm dependencies, local run):

- client typecheck: 7.4 s
- server typecheck: 1.7 s
- tests typecheck: 1.7 s
- hook algorithm tests: 0.6 s
- client algorithm tests: 0.8 s
- server algorithm tests: 1.7 s
- build-script tests: 3.4 s
- total: ~17 s

Cold lint was measured separately and excluded from the pre-build check set: 17.6 s (client) +
14.8 s (server).
