import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: path.join(repositoryRoot, 'src', 'preload', 'index.ts'),
      fileName: () => 'preload.js',
      formats: ['cjs'],
    },
    outDir: path.join(repositoryRoot, 'dist', 'preload'),
    // A sandboxed preload can require Electron built-ins but not sibling files, so the bridge graph
    // must be emitted as one CommonJS entry rather than TypeScript's directory-shaped module graph.
    rolldownOptions: {
      external: ['electron'],
    },
    sourcemap: true,
    target: 'node24',
  },
});
