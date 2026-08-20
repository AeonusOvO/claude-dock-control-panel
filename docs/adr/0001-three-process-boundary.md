# ADR-0001 三进程边界与 shared 层纯度

- 状态：已采纳
- 日期：2026-08-17

## 背景

Electron 应用有三个可执行上下文：Node.js 的 main、隔离上下文的 preload、Chromium 的 renderer。三者需要共享类型（IPC 载荷、状态快照、配置结构），也需要共享少量纯逻辑（reducer、ID 规范化、校验谓词）。

如果共享层允许 import `electron` 或 `node:*`，它就会被编译进渲染端产物：渲染进程在 `sandbox: true` 下没有这些模块，报错发生在运行时而不是编译时；同时把 Node 能力的引用面扩大到了浏览器上下文。

## 决策

`src/shared/` 是纯 TypeScript 底层：只有类型、常量和纯函数，不 import `electron`、不 import `node:*`、不引用 DOM 类型。

- main 允许 `shared/` + `electron` + `node:*`，禁止 import `renderer/` 与 `preload/`。
- renderer 允许 `shared/` + DOM，禁止 import `main/` 与 `preload/`。
- preload 允许 `shared/` + `electron` 的 `contextBridge`、`ipcRenderer`、`webUtils`，禁止 Node 内置模块。
- `shared/` 不 import 任何进程树。

规则写进 `.dependency-cruiser.cjs`，由 `npm run lint:deps` 执行。两套 tsconfig（`tsconfig.json` DOM lib / `tsconfig.main.json` Node lib）同时编译 `shared/`，纯度违规在类型检查阶段就暴露。

主窗口 `webPreferences` 固定为 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

## 结果

- 违规在 `npm run typecheck` 与 `npm run lint:deps` 阶段暴露，不留到运行时。
- 渲染端产物不含 Node 模块引用。
- 代价：`shared/` 里的逻辑不能直接读文件或调 Electron API，需要把这类操作留在 main 侧、只把结果传进纯函数。这是有意的额外一层参数传递。

## 备选方案

**允许 `shared/` 按环境分子目录（`shared/node/`、`shared/browser/`）** —— VS Code 的做法，但它有编译期的环境轴工具链支撑。本项目规模下，单一纯层的约束更简单，且能用一条 dependency-cruiser 规则表达。

**不设共享层，类型在两侧各写一份** —— IPC 载荷会静默分叉，编译期查不出来。
