import { configDefaults, defineConfig } from 'vitest/config';

const commonExcludes = [...configDefaults.exclude, '**/.claude/worktrees/**'];

const electronMockIsolatedTests = [
  'tests/main/claude-runtime-diagnostics.test.ts',
  'tests/main/main-config-transaction-integration.test.ts',
] as const;

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
    root: '.',
    exclude: commonExcludes,
    projects: [
      {
        extends: true,
        test: {
          name: 'parallel',
          exclude: [...commonExcludes, ...electronMockIsolatedTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'claude-runtime-diagnostics',
          include: [electronMockIsolatedTests[0]],
        },
      },
      {
        extends: true,
        test: {
          name: 'main-config-transaction-integration',
          include: [electronMockIsolatedTests[1]],
        },
      },
    ],
  },
});
