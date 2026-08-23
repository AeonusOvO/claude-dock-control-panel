# 架构

ClaudeDock 是 Windows 桌面 Electron 应用，用图形界面管理多个项目的 PowerShell/ConPTY 终端、Claude Code 与 Codex 会话、模型接入、路由、MCP、插件和更新。

## 进程边界

| 进程     | 运行环境   | 职责                                                                 |
| -------- | ---------- | -------------------------------------------------------------------- |
| main     | Node.js    | 窗口与托盘、ConPTY 会话、外部 CLI 进程、文件与凭据存储、全部业务状态 |
| preload  | 隔离上下文 | `contextBridge` 白名单 API，不导出 `ipcRenderer` 本体                |
| renderer | Chromium   | DOM、xterm.js、Markdown 渲染、Artifact 宿主                          |

主窗口的 `webPreferences`：

```ts
contextIsolation: true,
nodeIntegration: false,
sandbox: true,
preload: <dist/preload/preload.js>,
```

`setWindowOpenHandler` 一律返回 `deny`；外部链接经 `app:open-external` 交给主进程的 `shell.openExternal`。页面只加载项目内资源，CSP 由 `index.html` 的 `<meta http-equiv>` 声明。

## 分层依据

采用环境轴 × 领域轴的双轴分层：

- [VS Code Source Code Organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) —— `layer × target-environment` 双轴，层只向下依赖。
- [Electron Process Model & IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) —— 三进程边界；preload 白名单收口。
- [electron-vite 目录约定](https://electron-vite.org/guide/dev) —— `src/main` / `src/preload` / `src/renderer` 三入口。
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) —— 分层规则写成可执行检查，全部规则为 error。
- [ESLint max-lines](https://eslint.org/docs/latest/rules/max-lines) —— 上帝文件护栏。
- [Diátaxis](https://diataxis.fr/) —— 文档四分法。
- [ADR / MADR](https://adr.github.io/madr/) —— 决策记录与代码同仓演进。

具体目录与规则见 [project-layout.md](../reference/project-layout.md)。

## 状态所有权

主进程是全部业务状态的唯一事实源。渲染进程只持有派生的视图状态，不做业务判断。

| 状态                     | 主进程持有者                             | 推送方式                                                   |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| 项目列表、活动项目、主题 | `workspaceStore`                         | `workspace:state` 广播                                     |
| 每项目的 Claude 状态     | `claude-runtime`                         | `claude:state` 广播                                        |
| 每项目的 Codex 状态      | `codex-runtime`                          | `codex:state` 广播                                         |
| 原生对话快照             | `native-conversation` 会话               | `native-conversation:snapshot` 广播                        |
| 下载与更新               | `download-center`、`application-updater` | `download:changed`、`software:application-updater-changed` |
| 忙碌租约                 | `busy` 协调器                            | `busy:changed`                                             |

渲染进程重新打开某个界面时不重建状态，而是重放最近一次广播快照。

### 会话所有权键

一个对话由 `(runtime, normalized project, UUID)` 三元组唯一标识。原生会话、历史恢复和安全终端会尝试打开同一个对话，三元组保证只有一个持有者，第二个尝试收到 `conversation:owner-conflict`。

### 版本号

异步链路上过期消息会晚于新消息抵达，因此关键状态都带单调版本号，接收侧按版本丢弃：

| 版本号              | 保护的对象                                                |
| ------------------- | --------------------------------------------------------- |
| `ptyGeneration`     | 终端重启后旧 ConPTY 的写入、尺寸与输出                    |
| `resizeRevision`    | 乱序抵达的尺寸事件                                        |
| `stateRevision`     | 乱序抵达的 Claude 状态（`claudeStateOwnershipIsCurrent`） |
| capability revision | 模型、effort、权限模式、思考程度四个控件的原子更新        |

## 数据流

三条独立通路，形态与频率不同：

**请求响应**（166 个频道）—— 渲染端 `invoke`，主进程 `handle`，返回结构化结果。全部用户操作走这条路。

**终端字节流** —— 主进程 `node-pty` 读到字节后 `webContents.send('terminal:data')`，渲染端喂给 xterm.js；反向的按键走单向 `terminal:write`。单向而非请求响应，是为了避免每次按键产生一次 Promise 往返。

**事件推送**（23 个频道）—— 主进程状态变化后广播，渲染端订阅并重渲染对应界面。

完整频道表见 [ipc-contract.md](../reference/ipc-contract.md)。

## 外部进程

ClaudeDock 启动并管理外部 CLI，不捆绑第二份实现：

| 外部程序                  | 关系                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `claude`                  | 解析用户本机安装；终端会话直接运行，原生对话经 Claude Agent SDK |
| `codex`                   | 解析用户本机安装；5.0 RC 使用官方 TUI                           |
| CCR（Claude Code Router） | OpenAI 协议上游需要格式转换时自动安装并托管，只管理 CLI 包      |
| CLIProxyAPI               | 受管 ChatGPT 订阅接入的回环网关，从官方 Release 校验安装        |

密钥经 Electron `safeStorage`（Windows DPAPI）加密，不写入项目文件、命令行或终端历史。

网络预检的官方端点判定与出口环境评估都在主进程执行。第三方 IP 情报响应中的完整地址在主进程内
立即掩码，renderer 和诊断历史最多接收网段前缀；CLI 时区/语言修复只注入 ClaudeDock 后续创建的
子进程，不改 Windows 全局设置。

## 渲染进程分片

`src/renderer/main.ts` 从 15,886 行的单一作用域（HEAD `6ca456e` 基线实测；ADR-0006 时点记为 15,181）收敛为 46 行入口：15 个特性收进 `features/`（196 个 TypeScript 文件），跨特性外壳收进 `shell/`，与特性无关能力收进 `platform/`，装配分为 `bootstrap.ts`（DOM 环境与外壳）与 `feature-registration.ts`（特性注册与解析）。

每个特性导出注册式三件套（类型化 Symbol token、工厂注册函数、Feature 接口），经 `platform/registry.ts` 的 Registry 惰性构造，循环依赖在解析时报错。依赖方向只有特性 → shell → platform → shared：特性之间禁止互相 import，跨特性协作经 `shell/` 编排或 `platform/` 共享层，跨特性回调经显式 delegate 或 `-dependencies.ts` 最小接口。分片决策见 [ADR-0006](../adr/0006-feature-sliced-renderer.md) 与 [ADR-0011](../adr/0011-registration-based-feature-composition.md)。

## 测试策略

| 层次               | 工具                             | 覆盖                                                               |
| ------------------ | -------------------------------- | ------------------------------------------------------------------ |
| 单元与契约         | Vitest（部分用例 jsdom 环境）    | 纯函数、reducer、IPC 契约                                          |
| 行为测试           | Vitest + 三个 harness            | 渲染端模块加载驱动、主进程服务、IPC 往返（1,971 例通过，2 例跳过） |
| 资产契约           | Vitest + postcss                 | CSS 设计 token、HTML 结构、组件类名                                |
| 真实 Electron 冒烟 | `scripts/smoke/*-smoke.cjs`      | 布局、控件主题、原生 `<select>`、ConPTY 尺寸、视觉                 |
| 长时合成           | `scripts/smoke/runtime-soak.cjs` | 24 小时会话与资源行为                                              |

行为测试的基础设施是 `tests/helpers/` 的三个 harness（renderer-harness 加载真实渲染端模块并驱动 DOM、main-harness 组装主进程环境、ipc-harness 捕获 handler 并驱动往返）。源码文本钉（约 1,045 处）已全部转换为行为测试或资产契约，转换规则与设施见 [ADR-0009](../adr/0009-behavioral-tests-replace-source-pins.md)。

## 构建

| 步骤     | 命令                                                                                                             | 产物                |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| 图标     | `node scripts/build/generate-icons.mjs`                                                                          | `assets/generated/` |
| 类型检查 | `tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.main.json --noEmit` + `tsc -p tsconfig.preload.json --noEmit` | —                   |
| 主进程   | `tsc -p tsconfig.main.json`                                                                                      | `dist/main/`        |
| preload  | `vite build --config vite.preload.config.ts`                                                                     | `dist/preload/`     |
| 渲染端   | `vite build`                                                                                                     | `dist/renderer/`    |
| 安装包   | `electron-builder --win nsis`                                                                                    | `outputs/`          |
| 发布门禁 | `node scripts/release/manifest.mjs`                                                                              | 本地发布报告        |
| COS 发布 | `node scripts/release/publish-cos.mjs`                                                                           | 远端 generic feed   |

`npm run release` 组合安装包与本地发布门禁，不访问外部服务。COS publisher 只在显式命令和隔离的
发布凭据下运行：先原子创建并公开验证版本化安装包/blockmap，再加锁、预检并最后推进当前通道 YAML。

三个 tsconfig 分别覆盖渲染端与测试、主进程、preload。`shared/` 同时被三套配置检查，不能引用 `electron`、`node:*` 或 DOM 类型。preload 使用 Vite 打成单个 CommonJS 文件，满足 Electron sandbox 对本地模块加载的限制。

开发模式下 Vite 分别提供渲染端服务和 preload 监听构建，`tsc --watch` 增量编译主进程，`wait-on` 等待主进程与 preload 产物就绪后再启动 Electron。

`asarUnpack` 列出必须解包的原生模块与运行期脚本：`@lydell/node-pty`（ConPTY 原生绑定）与 `assets/runtime/*.ps1`（PowerShell 需要真实文件路径）。

## 打包体积

字体、Shiki 语法与主题、KaTeX 全部本地打包，不走 CDN。`vite.config.ts` 的 chunk 体积上限设为 1.2 MB，对应实测的最大块。
