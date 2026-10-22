import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src/viewer'),
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
