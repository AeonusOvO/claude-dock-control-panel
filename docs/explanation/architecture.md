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

| 状态                       | 主进程持有者                             | 推送方式                                                   |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 项目列表、活动项目、主题   | `workspaceStore`                         | `workspace:state` 广播                                     |
| 每项目的 Claude 状态       | `claude-runtime`                         | `claude:state` 广播                                        |
| 每项目的 Codex 状态        | `codex-runtime`                          | `codex:state` 广播                                         |
| 原生对话快照               | `native-conversation` 会话               | `native-conversation:snapshot` 广播                        |
| 每条 Claude 对话的接入身份 | `ConversationPreferencesStore`           | 按需检查 / 应用后随项目状态返回                            |
| 下载与更新                 | `download-center`、`application-updater` | `download:changed`、`software:application-updater-changed` |
| 忙碌租约                   | `busy` 协调器                            | `busy:changed`                                             |
| 启动引导进度               | `OnboardingStore`                        | 请求响应读取 / 原子 JSON 持久化                            |
| 下一个新建对话的开发引擎   | `AgentRuntimeStore.nextRuntime`          | `runtime:get-next` / `runtime:set-next`                    |

渲染进程重新打开某个界面时不重建状态，而是重放最近一次广播快照。渲染端自身的异步反馈也是派生视图状态：busy 文案、disabled、`aria-busy` 与 live status 必须属于精确 operation token 和 session generation。工作区、目录或状态快照的无关重绘只消费当前 owner，不能恢复控件；只有仍为 current 的操作 settlement 可以结束并恢复它。新建对话的 runtime 在 main 创建 session 时从全局 `nextRuntime` 捕获并固化到该 session；之后改变选择只影响下一次新建，不修改任何现有项目或兄弟会话。Codex installer 与 App Server 登录/账号状态在 main 中是应用级单例；main 暴露单调 `revision` 和精确 `{ attempt, kind }` operation descriptor，renderer reload 后恢复原操作文案与 owner，并拒绝延迟快照或 completion。插件变更同样由 main 应用级单例持有；catalog snapshot 带 `{ attempt, kind, target, phase }`，相同逻辑请求加入已有 Promise，竞争请求不排队，renderer 只在 active 期间轮询并锁定完整 mutation surface。

项目 `+` 的每次点击都拥有一个独立 session 和异步启动续体；同一项目连续点击十次不会合并，也不依赖哪一个终端仍在前台。只有 Codex 安装与登录这类应用级共享资源串行；等待者由 Codex/工作区状态事件立即唤醒，并以 5 秒异步定时器作为丢信号兜底，不占用 renderer 事件循环。历史索引使用异步文件 I/O，并在有界 JSONL 批次之间主动让出 main 事件循环，避免历史文件阻塞窗口与终端 IPC。

接入历史同样遵守双层所有权：renderer 的加载、应用、删除、重命名和专用恢复 surface 由单调 generation 与活动 session 共同持有，切换项目立即使旧 owner 失效；main 再确认该 session 仍映射到事务发起时的规范化项目目录。接入事务在 prepare 前保存项目配置快照，失败或取消时只在当前状态仍是本事务精确写入结果时恢复，并通过 prepared compensation 回滚它写入的 Router 外部状态；较新的项目配置或 Router 写入绝不被旧事务覆盖。

每条 Claude 对话还绑定创建或恢复时的完整接入身份：平台、协议、脱敏端点、认证方式、订阅账户或 API
凭据指纹、Router Provider、主模型和小型模型。终端与原生对话都从同一份不可变启动快照记录绑定，避免
配置在异步启动期间变化后把对话记到另一套模型。renderer 只取得脱敏投影；原始凭据仅在 main 的
`safeStorage` 密文中保存。历史恢复在 CLI 启动前比较完整身份，再按用户偏好询问、沿用当前接入或通过既有可回滚
配置事务恢复原接入并做真实连接测试。

Claude 官方账号状态也归 main。`official-auth-status.ts` 以有界命令调用读取 `claude auth status --json`，清除 Provider 覆盖后只把登录布尔值、安全账号标识、认证方式和检查时间投影到既有 `ClaudeProjectState`；令牌、原始 JSON 与未知字段不会跨进程，命令失败则显式降级。该能力复用现有 `claude:state` 请求与广播，不改变 IPC/API 数量。

### 会话所有权键

一个对话由 `(runtime, normalized project, UUID)` 三元组唯一标识。原生会话、历史恢复和项目终端会尝试打开同一个对话，三元组保证只有一个持有者，第二个尝试收到 `conversation:owner-conflict`。

### 版本号

异步链路上过期消息会晚于新消息抵达，因此关键状态都带单调版本号，接收侧按版本丢弃：

| 版本号              | 保护的对象                                                |
| ------------------- | --------------------------------------------------------- |
| `ptyGeneration`     | 终端重启后旧 ConPTY 的写入、尺寸与输出                    |
| `resizeRevision`    | 乱序抵达的尺寸事件                                        |
| `stateRevision`     | 乱序抵达的 Claude 状态（`claudeStateOwnershipIsCurrent`） |
| capability revision | 模型、effort、权限模式、思考程度四个控件的原子更新        |

## 数据流

三条独立通路共 209 个频道，形态与频率不同：

- **请求响应**（179 个）—— renderer `invoke`，main `handle`，返回结构化结果。
- **单向发送**（7 个）—— 高频或握手型 renderer → main 消息使用 `send/on`；包括 generation-fenced `terminal:write`，避免每次按键产生 Promise 往返。
- **事件推送**（23 个）—— main 状态变化后广播，renderer 订阅并重渲染对应界面。

`ControlPanelApi` 同样有 209 个成员，但分区不同：179 个请求方法、23 个事件订阅、6 个直接 send 方法和 1 个非 IPC `webUtils` 方法。第 7 个 send 频道由 `onAppQuitRequested` 的应答路径内部发出。完整映射见 [ipc-contract.md](../reference/ipc-contract.md)。

## 外部进程

ClaudeDock 启动并管理外部 CLI，不捆绑第二份实现：

| 外部程序                  | 关系                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `claude`                  | 解析用户本机安装；终端会话直接运行，原生对话经 Claude Agent SDK；登录状态通过有界 `auth status --json` 安全投影 |
| `codex`                   | 解析用户本机安装；5.0 RC 使用官方 TUI                                                                           |
| CCR（Claude Code Router） | OpenAI 协议上游需要格式转换时自动安装并托管，只管理 CLI 包                                                      |
| CLIProxyAPI               | 受管 ChatGPT 订阅接入的回环网关，从官方 Release 校验安装                                                        |

密钥经 Electron `safeStorage`（Windows DPAPI）加密，不写入项目文件、命令行或终端历史。

网络预检在主进程保留两条独立证据通道：精确 Provider 端点的 DNS/TLS/HTTP/应用/CLI/必需 WebSocket 决定连接可用性；公网地址、DNS 对照、IPv6、STUN、接口、环境和信誉只形成目标限定的建议证据。每项建议 check 都携带 authority、process、scope、target、transport、时间、新鲜度和置信度；cache/history 投影明确标为 cached，不伪造不可用地址族。第三方响应中的完整地址不进入 renderer 或诊断历史；CLI 时区覆盖只注入 ClaudeDock 后续创建的子进程，不改 Windows 全局设置。

## 渲染进程分片

`src/renderer/main.ts` 从 15,886 行的单一作用域（HEAD `6ca456e` 基线实测；ADR-0006 时点记为 15,181）收敛为 46 行入口：16 个特性收进 `features/`，跨特性外壳收进 `shell/`，与特性无关能力收进 `platform/`，装配分为 `bootstrap.ts`（DOM 环境与外壳）与 `feature-registration.ts`（特性注册与解析）。启动引导是独立 `onboarding` 特性；renderer 只持有步骤呈现，版本化状态归 main 的 `OnboardingStore`。

每个特性导出注册式三件套（类型化 Symbol token、工厂注册函数、Feature 接口），经 `platform/registry.ts` 的 Registry 惰性构造，循环依赖在解析时报错。依赖方向只有特性 → shell → platform → shared：特性之间禁止互相 import，跨特性协作经 `shell/` 编排或 `platform/` 共享层，跨特性回调经显式 delegate 或 `-dependencies.ts` 最小接口。分片决策见 [ADR-0006](../adr/0006-feature-sliced-renderer.md) 与 [ADR-0011](../adr/0011-registration-based-feature-composition.md)。

## 测试策略

| 层次               | 工具                             | 覆盖                                               |
| ------------------ | -------------------------------- | -------------------------------------------------- |
| 单元与契约         | Vitest（部分用例 jsdom 环境）    | 纯函数、reducer、IPC 与 package 契约               |
| 行为测试           | Vitest + 三个 harness            | renderer 模块驱动、main 服务、IPC 往返与竞态       |
| 资产契约           | Vitest + postcss                 | CSS token、HTML 结构、本地资源来源与安全结构       |
| 真实 Electron 冒烟 | `scripts/smoke/*-smoke.cjs`      | 布局、控件主题、原生 `<select>`、ConPTY 尺寸、视觉 |
| 长时合成           | `scripts/smoke/runtime-soak.cjs` | 24 小时会话与资源行为                              |

行为测试的基础设施是 `tests/helpers/` 的三个 harness（renderer-harness 加载真实 renderer 模块并驱动 DOM、main-harness 组装 main 环境、ipc-harness 捕获 handler 并驱动往返）。实现形态优先通过可观察行为验证；package/config、设计系统和带来源哈希的本地资产使用结构化契约，少数纯模块另保留禁止 network/subprocess/global mutation 能力的窄范围负向源码扫描，完整边界见 [验证清单](../how-to/verify.md) 与 [ADR-0009](../adr/0009-behavioral-tests-replace-source-pins.md)。

## 构建

- 源码身份：`node scripts/build/source-identity.mjs` → `dist/build-source-identity.json`
- 图标：`node scripts/build/generate-icons.mjs` → `assets/generated/`
- 类型检查：`tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.main.json --noEmit` + `tsc -p tsconfig.preload.json --noEmit`
- 主进程：`tsc -p tsconfig.main.json` → `dist/main/`
- preload：`vite build --config vite.preload.config.ts` → `dist/preload/`
- 渲染端：`vite build` → `dist/renderer/`
- 安装包：`electron-builder --win nsis` → `outputs/`
- 发布编排：`node scripts/release/release.mjs` → 质量门禁 + 安装包 + 本地报告
- 发布门禁：`node scripts/release/manifest.mjs` → 本地发布报告
- COS 发布：`node scripts/release/publish-cos.mjs` → 远端 generic feed

`npm run build` 在 clean 后先生成源码身份，再执行任何生成、typecheck 或编译。`npm run release` 只接受
clean exact commit 和空 `outputs/`，以 Node built-in 编排 `npm ci`、lint、format、全部 typecheck、全量
Vitest、dependency-cruiser、`npm run dist`、源码身份复核和 manifest，不访问外部服务。manifest 通过 pinned
7z 把 NSIS payload 逐字节绑定到 `win-unpacked`，并重算 blockmap v2 的 BLAKE2b-144 chunks。COS publisher
只在显式命令和隔离的发布凭据下运行：先 frozen revalidation，再原子创建并公开验证版本化
installer/blockmap，最后加锁、预检并推进当前通道 YAML。

三个 tsconfig 分别覆盖渲染端与测试、主进程、preload。`shared/` 同时被三套配置检查，不能引用 `electron`、bare 或 `node:` 形式的 Node core import，也不能引用 DOM 类型。preload 使用 Vite 打成单个 CommonJS 文件，满足 Electron sandbox 对本地模块加载的限制。

开发模式下 Vite 分别提供渲染端服务和 preload 监听构建，`tsc --watch` 增量编译主进程，`wait-on` 等待主进程与 preload 产物就绪后再启动 Electron。

`asarUnpack` 列出必须解包的原生模块与运行期脚本：`@lydell/node-pty`（ConPTY 原生绑定）与 `assets/runtime/*.ps1`（PowerShell 需要真实文件路径）。根目录 `LICENSE` 与 `NOTICE` 是 electron-builder `build.files` 的显式打包契约，必须能在最终应用包中读取。

## 打包体积

字体、Shiki 语法与主题、KaTeX 全部本地打包，不走 CDN。`vite.config.ts` 的 chunk 体积上限设为 1.2 MB，对应实测的最大块。
