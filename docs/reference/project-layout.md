# 目录结构与依赖规则

## 分层

四层，只向下依赖：

```
shared/     纯 TypeScript：类型、常量、纯函数
  ↑
preload/    shared/ + electron 的 contextBridge、ipcRenderer、webUtils
  ↑                              ↑
main/       shared/ + electron    renderer/   shared/ + DOM
            + node:*                          禁止 main/、preload/
            禁止 renderer/
```

`shared/` 编译进全部三个进程，因此不能出现 `electron`、bare / `node:` Node core import 或 DOM 类型。`main/` 与 `renderer/` 互不 import，只通过 IPC 通信（见 [ipc-contract.md](ipc-contract.md)）。

## 仓库根

新增入口：`src/main/usage/transcript-worker.ts`（后台用量读取）与 `src/renderer/usage-widget.html` /
`usage-widget.ts`（置顶悬浮球）。main 入口由 TypeScript 编译，Vite 对主页面和悬浮球进行多页构建；
两个 renderer 入口共享纯展示/主题代码，不共享终端与对话运行时。依赖规则仅增加这两个明确入口豁免。

| 路径                       | 内容                                                  |
| -------------------------- | ----------------------------------------------------- |
| `assets/source/`           | SVG 图标源                                            |
| `assets/generated/`        | `generate-icons.mjs` 产出的 PNG/ICO                   |
| `assets/runtime/`          | 打包进安装包的 PowerShell 运行期脚本                  |
| `build/installer.nsh`      | electron-builder NSIS 自定义段                        |
| `docs/`                    | 全部文档，见 [docs/README.md](../README.md)           |
| `scripts/`                 | 构建、验收与 release/COS 发布脚本                     |
| `src/`                     | 三个进程树 + `shared/`                                |
| `tests/`                   | Vitest 测试                                           |
| `dist/`                    | `npm run build` 产出（忽略）                          |
| `outputs/`                 | 安装包、通道 YAML、发布报告与解包候选（忽略）         |
| `.github/workflows/ci.yml` | lint、format:check、typecheck、test、lint:deps、build |
| `.dependency-cruiser.cjs`  | 分层、循环、孤儿规则                                  |
| `tsconfig.json`            | 渲染端与测试、`shared/`（DOM lib）                    |
| `tsconfig.main.json`       | 主进程（Node lib）                                    |
| `tsconfig.preload.json`    | preload（Node lib）                                   |
| `vite.config.ts`           | 渲染端构建                                            |
| `vite.preload.config.ts`   | preload 构建                                          |

`scripts/build/source-identity.mjs` 在 clean 后、任何生成或编译前写入
`dist/build-source-identity.json`；该无凭据文件随 `dist/**/*` 进入 ASAR。`scripts/release/release.mjs` 从 clean
exact commit 编排重装、质量门禁、`npm run dist`、源码身份复核和 manifest；
`scripts/release/manifest.mjs` 校验当前 `rc.yml`、`beta.yml` 或 `latest.yml`、NSIS payload、blockmap 和
packaged identity 并生成本地 `release-manifest.json`。`scripts/release/publish-cos.mjs` 使用环境凭据发布到
固定 COS prefix。release 脚本不进入 Electron 运行时，也不把 COS 写凭据写进 `outputs/`。

`AGENTS.md` 与 `README.md` 留在根目录：前者是 agent 工具链的固定读取位置，后者是仓库首页。两者都是索引，正文在 `docs/`。

## `src/shared/`

```
shared/
  network-preflight-policy.ts  自动检测开关与动作的纯映射，main/renderer 共用
  contracts/              跨进程类型导出，零运行期代码
    index.ts              桶文件，`export type *` re-export 全部类型
    app.ts artifact.ts chat.ts claude.ts claude-execution-settings.ts
    claude-plugin.ts codex.ts diagnostics.ts download.ts egress-diagnostics.ts
    managed-chatgpt.ts mcp.ts network.ts proxy.ts resource.ts router.ts
    onboarding.ts runtime.ts software.ts subscription.ts terminal.ts workspace.ts
    control-panel-api.ts  22 个域接口组合出 ControlPanelApi 的 219 个成员
  claude/                 connection-remedy context-window curl effort model-id
                          native-commands permission-mode providers state-ownership subscriptions
  conversation/           native reducer surface-switch composer-input
                          composer-history chat-usage
  router/                 capabilities kernel provider-profiles connection-endpoint
  ui/                     terminal-themes cli-command-catalog plugin-localization
                          mcp-catalog update-actions
```

`contracts/index.ts` 是全仓唯一的桶文件——它是跨进程公共边界，下游 200 多处 import 靠它保持不变。进程内部一律直接 import 具体文件，避免打包体积与循环依赖问题。

`contracts/` 内部依赖是单向的：`app → chat → claude → {resource, terminal, workspace}`，`codex`/`router`/`managed-chatgpt → claude`，`runtime → terminal`，其余域文件无内部依赖。`ClaudeRouterGatewayState` 放在 `claude.ts` 而非 `router.ts`，因为保存的 Claude 连接记录它，反向会成环（dependency-cruiser 的 `tsPreCompilationDeps` 把纯类型 import 也计入图）。

`ui/` 放界面呈现所需的目录与派生（主题授权值、CLI 命令表、插件文案、MCP 精选表、更新按钮状态）；主进程也 import 其中两个（校验主题 ID、按精选表安装 MCP），它们是数据而非渲染代码。

文件名不重复目录名：`claude/effort.ts` 而不是 `claude/claude-effort.ts`。

## `src/main/`

```
main/
  index.ts                装配：Registry、服务构造、依赖容器、生命周期接线
  app/                    bootstrap/lifecycle/window/tray/profile/paths + startup model restore/coordinator
  infra/                  registry.ts service-tokens.ts contributions.ts logger.ts
                          diagnostics.ts 等；Registry 与四类贡献点见 ADR-0010
  ipc/                    32 个文件 = 26 个域 handler + 基础设施 + 入口：
    index.ts              registerIpc(deps)：一次跑完全部贡献
    contributions.ts      MAIN_IPC_CONTRIBUTIONS：26 个域贡献的注册数组
    contribution.ts       IpcContribution 类型与依赖推导工具
    context.ts guards.ts validation.ts   MainState、guards、共享校验
    app.ts artifact.ts busy.ts chat.ts claude-connection.ts claude-controls.ts
    claude-execution-settings.ts claude-launch.ts claude-plugin.ts claude-state.ts codex.ts conversation.ts
    conversation-attachment.ts download.ts managed-chatgpt.ts mcp.ts network.ts
    onboarding.ts project.ts proxy.ts router.ts runtime.ts session.ts software.ts subscription.ts terminal.ts
  claude/                 项目配置事务、接入历史、路由、运行态等
    official-auth-status.ts  `claude auth status --json` 的缓存与安全白名单投影
  codex/ chat/ conversation/ terminal/ network/ proxy/
  subscriptions/          service oauth zcode relay vault catalog http account：账号授权、固定回环转发、加密凭据与账户投影
  download/ mcp/ artifact/ updates/ stores/ coordination/
```

handler 之间禁止互相 import：共享只经 `context/guards/validation`，注册只经 `contributions.ts` 聚合器与 `index.ts` 入口（dependency-cruiser 的 error 规则）。

`app/paths.ts` 由 `app.getAppPath()` 单点推导 `preload.js` 与 `index.html` 的位置。此前这两条路径写作 `path.join(__dirname, '..', ...)`，依赖文件所在深度，文件移入子目录后会在打包产物里静默失效。

`network/preflight-service-identity.ts` 持有路由身份、所需 scope 与 epoch 摘要等纯派生；
`preflight-service-errors.ts` 收口租约失效错误。服务层保留原有导出兼容调用者，探测与不探测的业务入口
均通过同一套 route lease 生命周期校验，不把关闭自动检测实现为跳过整个网络事务。

## `src/preload/`

```
preload/
  index.ts                展开组装 22 个 bridge，satisfies ControlPanelApi，单点暴露
  bridges/                按域拆分的 22 个桥文件：app application-proxy artifact busy
                          chat claude claude-execution-settings claude-plugin codex download managed-chatgpt mcp
                          native-attachment native-conversation network-preflight onboarding
                          router runtime software-update subscription terminal workspace
```

通道名常量与载荷校验在 `src/shared/ipc/`（`channels.ts` 219 个常量，通用 schema 与 Claude 执行 schema 分文件维护），preload 与 main 两侧同源引用，见 [ADR-0008](../adr/0008-ipc-single-source-of-truth.md)。

## `src/renderer/`

```
renderer/
  index.html              手写 HTML 骨架
  main.ts                 46 行：字体样式 + 组件套件 + 滚动链 + new Registry + bootstrap
  bootstrap.ts            DOM 环境、RuntimeState、ShellStack 装配
  feature-registration.ts 16 个特性的注册与解析，按阶段分组
  runtime-types.ts        RuntimeState / ShellStack / FeatureBundle 三层类型
  app-lifecycle.ts        生命周期钩子
  styles.css              @import 七层样式 + views/ 视图样式
  platform/               与特性无关能力：registry.ts components.ts dom.ts
                          format.ts percentage-utils.ts artifact.ts
                          claude-launch-attempt.ts composer-submit.ts
                          scroll-chaining.ts session-generation.ts
                          terminal-output-pump.ts terminal-view.ts markdown/
  shell/                  跨特性外壳：rail footer dialogs workbench toast theme
                          runtime-activity 及各自的 -dependencies / -preview 文件
  features/               16 个特性：artifact chat claude-execution-settings connection
                          conversation downloads mcp onboarding plugins preflight projects proxy
                          router settings terminal updates
```

每个特性的 `index.ts` 导出注册式三件套（见 [ADR-0011](../adr/0011-registration-based-feature-composition.md)）：

| 导出                    | 内容                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `<NAME>_FEATURE`        | `createRegistryToken<Feature>()` 的类型化 Symbol token           |
| `register<Name>Feature` | `(registry, deps) => registry.register(token, factory)` 工厂注册 |
| `Feature` 接口          | 该特性对外暴露的成员，消费方按 token 解析                        |

特性内部按五文件（elements/state/view/actions/index）划分；单族职责超过可维护规模时以主题前缀拆子工厂（如 terminal 的 `terminal-io-*`、`terminal-layout-*`、`terminal-views-*`、`project-state-*`、`codex-launch-*` 五族）。connection 的历史与启动恢复子流按 `history-dialog / history-render / history-mutations / history-recovery / current-connection-view / startup-model-connection` 拆分：分类弹窗只持有选择，恢复页持有运行期状态，顶部摘要只消费脱敏项目状态，启动遮罩只消费 main 快照并派生 inert/倒计时。跨特性依赖只经两条通道：显式 delegate（`{ current }` 引用盒）与 `-dependencies.ts` 最小接口（消费方声明鸭子类型，装配处传完整实例）。真正跨特性的状态（`workspaceState`、`selectedRailTab`、`mainView`、toast）归 `shell/`。

### 样式

`styles.css` 按数字前缀顺序 `@import` 七个层，再 `@import` `views/` 下的视图样式。

| 层                  | 内容                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `01-tokens.css`     | CSS 自定义属性                                                                            |
| `02-reset.css`      | 归一化                                                                                    |
| `03-typography.css` | 字体与文本                                                                                |
| `04-motion.css`     | 过渡与动画                                                                                |
| `05-primitives.css` | 按钮、输入、卡片等控件                                                                    |
| `06-layout.css`     | 应用骨架                                                                                  |
| `07-responsive.css` | 断点                                                                                      |
| `views/*.css`       | 单视图样式：chat、connection-history、markdown、mcp、projects、router、settings、terminal |

## `tests/`

```
tests/
  helpers/                renderer-harness.ts（377 行：jsdom 环境加载渲染端模块）
                          main-harness.ts（430 行：electron mock + Registry + MainState）
                          ipc-harness.ts（164 行：ipcMain.handle 捕获与往返）
                          renderer-interaction-fixture.ts renderer-terminal-fixture.ts
                          renderer-css.ts main-service-registry.ts
  shared/ main/ preload/ renderer/ scripts/
```

行为测试基础设施与转换规则见 [ADR-0009](../adr/0009-behavioral-tests-replace-source-pins.md)；`source-corpus.ts` 已删除。

## `scripts/`

```
scripts/
  build/    clean.mjs generate-icons.mjs source-identity.mjs
  release/  release.mjs manifest.mjs artifact-integrity.mjs publish-cos.mjs
  smoke/    conpty-resize-smoke.cjs control-theme-smoke.cjs dialog-select-smoke.cjs
            layout-smoke.cjs native-visual-smoke.cjs real-electron-visual-qa.cjs
            runtime-soak.cjs select-interaction-smoke.cjs select-theme-smoke.cjs
            visual-smoke.cjs
  tools/    tokenize-colors.cjs
```

## 可执行的依赖规则

`.dependency-cruiser.cjs`，通过 `npm run lint:deps` 运行。

- `no-circular`（error）：禁止循环依赖
- `no-orphans`（error）：禁止孤儿模块（入口、`.d.ts`、`tests/`、根配置除外）
- `shared-stays-pure`（error）：`src/shared/` 不得依赖 bare / `node:` Node core
- `shared-no-electron`（error）：`src/shared/` 不得依赖 `electron`
- `shared-imports-nothing-above`（error）：`src/shared/` 不得 import 任何进程树
- `main-not-to-renderer`（error）：`src/main/` 不得 import `renderer/` 或 `preload/`
- `renderer-not-to-main`（error）：`src/renderer/` 不得 import `main/` 或 `preload/`
- `preload-only-shared`（error）：`src/preload/` 不得 import `main/` 或 `renderer/`
- `preload-no-node-builtins`（error）：preload 不得 import bare / `node:` Node core
- `src-not-to-tests`（error）：`src/` 不得依赖 `tests/`
- `no-unresolvable`（error）：禁止无法解析的 import
- `src-not-to-dev-dep`（error）：`src/` 不得依赖 devDependency（`electron` 例外，由打包后的二进制提供）
- `main-ipc-handlers-are-isolated`（error）：`src/main/ipc/` 域 handler 之间禁止互相 import
- `renderer-feature-<name>-is-isolated`（error）：`features/<name>/` 不得 import 其他特性（按目录动态生成 15 条）

全部规则为 error；`lint` 脚本同时要求 `--max-warnings=0`，任何 warning 即失败。

依赖图人工核对：

```powershell
npx depcruise src --output-type mermaid
npx depcruise src --output-type archi
```

## 文件体积护栏

`eslint.config.mjs` 的 `max-lines` 与 `max-lines-per-function` 是上帝文件的直接护栏，阈值随实际最大值下调。

当前最大的源文件（物理行；ESLint `max-lines` 另计，它跳过空行与注释）：

| 行数  | 文件                                                    |
| ----- | ------------------------------------------------------- |
| 3,037 | `src/renderer/styles/views/terminal.css`                |
| 2,943 | `src/renderer/index.html`                               |
| 2,024 | `src/renderer/styles/views/router.css`                  |
| 1,536 | `src/renderer/styles/views/settings.css`                |
| 1,157 | `src/renderer/styles/05-primitives.css`                 |
| 1,077 | `tests/main/claude-runtime-diagnostics.test.ts`         |
| 1,057 | `tests/main/claude-runtime-pty.test.ts`                 |
| 1,042 | `tests/main/main-process-operation-coordinator.test.ts` |
| 994   | `src/renderer/styles/views/chat.css`                    |
| 968   | `src/renderer/platform/markdown/index.ts`               |
| 955   | `src/main/claude/runtime.ts`                            |

最大的 TypeScript 源文件 968 行（`platform/markdown/index.ts`），全部在护栏内。
