import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src/viewer'),
      // Repo-local packages shared with the server (see packages/pricing/README.md). Consumed from
      // source through these aliases: bun cannot link a `file:` dependency on Windows.
      '@loghub/pricing': path.resolve(dirname, '../packages/pricing/src/index.ts'),
      '@loghub/bash-view': path.resolve(dirname, '../packages/bash-view/src/index.ts'),
    },
  },
  // web-tree-sitter loads its own .wasm via import.meta.url; pre-bundling breaks that path.
  optimizeDeps: {
    exclude: ['web-tree-sitter'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The alias above reaches outside client/; let the dev server serve those files.
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(dirname, '../packages')],
    },
    // Set (e.g. to 0.0.0.0) inside the dev container so the published port reaches Vite;
    // unset on the host, where Vite keeps its default.
    host: process.env.LOG_HUB_VITE_HOST || undefined,
    proxy: {
      '/api': 'http://localhost:3000',
      '/static': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [
      './src/test/setup.ts',
      './src/viewer/__tests__/setup-vitest.ts',
    ],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
  },
});
