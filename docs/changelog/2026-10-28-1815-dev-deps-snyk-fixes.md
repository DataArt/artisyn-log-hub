# Dependency security updates

- The server's `qs` (used by Express to parse form bodies) is pinned to the patched 6.16.2.
- Development tools move to patched versions: esbuild under drizzle-kit, brace-expansion, js-yaml,
  fast-uri, vitest and postcss-selector-parser. No change in app behaviour.
