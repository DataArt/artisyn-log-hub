---
paths: ["lib/**/*.js"]
---

# CLI flags

Every command-line flag in this project must have:

- a long form (`--flag-name`); short aliases are optional, the long form is not;
- a `--help` line in the `HELP` text of `lib/args.js` describing what the flag does;
- a default value declared in `DEFAULTS` in `lib/args.js` and shown in its `--help` line.
