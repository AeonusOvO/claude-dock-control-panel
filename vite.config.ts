import { configDefaults, defineConfig } from 'vitest/config';
import path from 'node:path';

// Research checkouts and generated artifacts are data, never executable project tests.
const commonExcludes = [
  ...configDefaults.exclude,
  '**/.claude/worktrees/**',
  '**/work/**',
  '**/outputs/**',
];

const electronMockIsolatedTests = [
  'tests/main/claude-runtime-diagnostics.test.ts',
  'tests/main/main-config-transaction-integration.test.ts',
] as const;

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    rolldownOptions: {
      input: {
        main: path.resolve('src/renderer/index.html'),
        usageWidget: path.resolve('src/renderer/usage-widget.html'),
      },
    },
    // Keep bundled visual assets as inspectable packaged files; brand provenance must not be folded
    // into opaque data URLs in the renderer document.
    assetsInlineLimit: 0,
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
