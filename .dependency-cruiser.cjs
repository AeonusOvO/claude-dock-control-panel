/**
 * Dependency rules for the three Electron process trees.
 *
 * `shared/` is pure TypeScript, so both process trees can import it; neither process
 * tree may import the other, and nothing may import back into `shared/`'s consumers.
 * Every rule is `error`: the legacy layout has been fully unwound, so any new
 * violation fails `npm run lint:deps` outright.
 */

const { readdirSync } = require('node:fs');
const path = require('node:path');

/** Modules that are launched by Electron or Vite rather than imported by another module. */
const ENTRY_POINTS =
  '^src/(main/((main|index)\\.ts|usage/transcript-worker\\.ts)|preload/(preload|index)\\.ts|renderer/(main|usage-widget)\\.ts)$';

/**
 * Renderer features are horizontally isolated: a feature may import its own directory,
 * `shell/`, `platform/`, and `shared/`, but never a sibling feature. One rule is
 * generated per top-level feature directory so new features are covered automatically.
 */
const rendererFeatureIsolationRules = readdirSync(
  path.join(__dirname, 'src', 'renderer', 'features'),
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory())
  .map((feature) => ({
    name: `renderer-feature-${feature.name}-is-isolated`,
    comment:
      '特性之间不直接 import：跨特性协作只能经 shell/ 编排或 platform/ 共享层，避免特性网格。',
    severity: 'error',
    from: { path: `^src/renderer/features/${feature.name}/` },
    to: {
      path: '^src/renderer/features/',
      pathNot: `^src/renderer/features/${feature.name}/`,
    },
  }));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A cycle makes both modules unloadable in isolation, so neither can be unit tested.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'An orphan is either dead code or a missing import.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: [ENTRY_POINTS, '\\.d\\.ts$', '(^|/)tests/', '^[^/]+\\.(json|js|cjs|mjs|ts)$'],
      },
      to: {},
    },
    {
      name: 'shared-stays-pure',
      comment:
        '`src/shared/` compiles into every process, so it may not reach for Node built-ins through node: or bare specifiers.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'shared-no-electron',
      comment: '`src/shared/` compiles outside Electron and may not import the Electron runtime.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^(electron|node_modules/electron)(/|$)' },
    },
    {
      name: 'shared-imports-nothing-above',
      comment:
        '`src/shared/` is the bottom layer; importing a process tree inverts the dependency.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(main|preload|renderer)/' },
    },
    {
      name: 'main-not-to-renderer',
      comment: 'The main process runs in Node and cannot load renderer modules.',
      severity: 'error',
      from: { path: '^src/main/' },
      to: { path: '^src/(renderer|preload)/' },
    },
    {
      name: 'renderer-not-to-main',
      comment:
        'The renderer talks to the main process over IPC only; importing it would bundle Node code into the browser context.',
      severity: 'error',
      from: { path: '^src/renderer/' },
      to: { path: '^src/(main|preload)/' },
    },
    {
      name: 'preload-only-shared',
      comment:
        'Preload runs in an isolated context with a narrow API surface: `shared/` types and Electron only.',
      severity: 'error',
      from: { path: '^src/preload/' },
      to: { path: '^src/(main|renderer)/' },
    },
    {
      name: 'preload-no-node-builtins',
      comment:
        'Node built-ins reached through preload via node: or bare specifiers would be exposed across the context bridge.',
      severity: 'error',
      from: { path: '^src/preload/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'src-not-to-tests',
      comment: 'Test helpers are not shipped, so production code cannot depend on them.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^tests/' },
    },
    {
      name: 'no-unresolvable',
      comment: 'An unresolvable import is a typo or a missing dependency.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'src-not-to-dev-dep',
      comment:
        'A devDependency reached from `src/` is missing from the installed app. `electron` is the exception: it supplies the runtime and is provided by the packaged binary rather than by `node_modules`.',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.d\\.ts$' },
      to: {
        dependencyTypes: ['npm-dev'],
        dependencyTypesNot: ['type-only'],
        pathNot: '^(electron|node_modules/electron)(/|$)',
      },
    },
    {
      name: 'main-ipc-handlers-are-isolated',
      comment:
        'IPC 域处理器彼此独立：handler 只依赖共享的 validation/guards/context 基础设施，注册只经 contributions 聚合器与 index 入口。',
      severity: 'error',
      from: {
        path: '^src/main/ipc/',
        pathNot: '^src/main/ipc/(index|contributions)[.]ts$',
      },
      to: {
        path: '^src/main/ipc/',
        pathNot: '^src/main/ipc/(validation|guards|context|contribution)[.]ts$',
      },
    },
    ...rendererFeatureIsolationRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|outputs|coverage|release|work)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      archi: { collapsePattern: '^src/(main|preload|renderer|shared)/[^/]+' },
      dot: { collapsePattern: '^src/(main|preload|renderer|shared)/[^/]+' },
    },
  },
};
