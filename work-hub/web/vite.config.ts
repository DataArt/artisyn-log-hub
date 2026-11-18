import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The Work Hub server (`cargo run`) listens on 3100. The proxy keeps the browser's Host header
// (no changeOrigin), so the server's WebSocket Origin check sees localhost:5180 on both sides.
// WORK_HUB_DEV_API points the dev UI at another running server (e.g. a dockerized one).
const serverUrl = process.env.WORK_HUB_DEV_API || 'http://localhost:3100';

const NO_LANGUAGE_SERVICE = '\0monaco-no-language-service';

/**
 * D19: only Monaco's editor worker is bundled. `monaco-editor/editor/editor.main` also registers
 * the CSS, HTML, JSON and TypeScript language services, each of which brings its own worker
 * (`new Worker(new URL('…worker.js', import.meta.url))`, several MB for TypeScript). Their
 * `register.js` modules are replaced by an empty one; syntax highlighting stays (Monarch).
 */
function monacoWithoutLanguageServices(): Plugin {
  return {
    name: 'work-hub-monaco-without-language-services',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        importer !== undefined &&
        importer.replace(/\\/g, '/').includes('/monaco-editor/esm/vs/') &&
        /\/languages\/features\/(css|html|json|typescript)\/register\.js$/.test(source)
      ) {
        return NO_LANGUAGE_SERVICE;
      }
      return null;
    },
    load(id) {
      return id === NO_LANGUAGE_SERVICE ? 'export {};' : null;
    },
  };
}

export default defineConfig({
  plugins: [monacoWithoutLanguageServices(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Pre-bundling (esbuild) would skip the plugin above in dev; Monaco is served as plain ESM.
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: serverUrl, ws: true },
      '/health': { target: serverUrl },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.algo.test.ts'],
    passWithNoTests: true,
  },
});
