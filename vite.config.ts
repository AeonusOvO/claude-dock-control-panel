import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    // Shiki's WASM engine and language grammars ship inside the bundle so that highlighting works
    // without network access, which puts the single renderer entry chunk well above Vite's 500 kB
    // default threshold.
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
