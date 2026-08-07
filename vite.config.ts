import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    // Shiki's WASM/language grammars and the single renderer entry are intentionally local-first;
    // 1.2 MB is the audited budget, not an accidental default-warning suppression.
    chunkSizeWarningLimit: 1_200,
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
    root: '.',
  },
});
