# ClaudeDock 技术说明

当前架构版本：5.0.0-rc.30（2026-08-26）。版本化工作区启动引导以 main 进程持久化状态、
类型化 IPC 与 renderer feature 分片共同维护“选择引擎、选择模型、自动准备、打开项目、准备完成”五步事务；旧用户迁移、
跳过、续接和重置均不保存密钥或项目正文。顶层信息架构收敛为“工作区 / 独立对话 / 接入 / 扩展”，接入与扩展
使用完整内容画布，工作区运行时选择器改为按需展开。主题字体、文字层级、自适应控件及来源可追踪的非线性动效
继续由设计 token 与行为门禁统一约束。

renderer 入口继续保持 feature-sliced shell/platform 注册架构，IPC 的 channel/schema/preload 桥是单一
事实源，main 通过运行期注册表与 contribution 装配，lint 与 dependency-cruiser 维持零警告门禁
（ADR-0008 至 ADR-0011）。应用更新继续由单一 electron-updater 状态源读取腾讯云 COS generic feed；
RC 使用 `rc.yml`，稳定版使用 `latest.yml`，发布顺序固定为不可变资产、公开摘要验证、通道清单最后提交
（ADR-0007）。

PowerShell/ConPTY 安全终端与显式原生对话入口继续并存。`RuntimeProfile/AppPaths` 隔离、统一
`ConversationAdapter`、single-owner registry、加密恢复、附件存储、模型能力、权限 contract、launch-owned
Hook、后台任务和受控派生进程保持有效。Agent SDK 只解析用户本机 `claude` 安装；构建排除 SDK 平台
二进制并扫描 `app.asar`/`win-unpacked`，发现第二份 `claude.exe` 即失败。Codex 继续使用官方 TUI/ConPTY，
本候选版不迁移到实验性 App Server 会话。

旧版设计计划、路线图、缺陷清单与分阶段修复提示词统一保存在 [`docs/archive/`](../archive/)；
这些文件只用于追溯历史，不是当前架构规格、Agent 指令或发布门禁。

## 工作区导航与启动引导

- renderer 的 `features/onboarding/` 按 `elements / state / view / actions / environment / index`
  分片。view 只管理步骤、焦点、背景 `inert`、来源原点和双向退出；actions 负责 IPC、目录选择器和
  键盘；environment 只消费现有软件版本能力，不复制安装或接入业务。
- main 的 `OnboardingStore` 写入 `userData/app-preferences/onboarding.json`，当前 storage/flow version
  都是 2。写入沿用临时文件 + rename 的原子替换；读取时逐项校验 status、step、engine、model choice、
  domestic model 和时间，损坏或
  新版本不兼容时回到安全默认值。检测到既有 `app-preferences/app.json`、旧 preferences、workspace、
  对话或连接历史时返回 completed，避免升级后强制弹出。
- `onboarding:get/update/complete/skip/reset` 通过独立 preload bridge 暴露。progress input 只允许
  `{ currentStep, completedSteps, engine?, modelChoice?, domesticModel? }`；domestic model 只能取内置
  provider ID 白名单。main 不接收密钥、令牌、自由模型 ID、项目路径或项目内容。v1 的
  `claude/codex/provider` 路径在首次读取时迁移为等价的 engine/model choice 并原子写回，已完成用户不重播引导。
- 顶层 rail 把 plugins / MCP 规范化为 `extensions`，内部 `extensionTab` 决定真实 rail page；旧的
  `/plugins` 与 `/mcp` 命令仍可传入原名称，由 shell 规范化到同一顶层入口。connection 与 extensions
  设置 `workspace.dataset.railPanel` 后跨越原侧栏、分隔条与终端列，退出时回到 projects。
- 引导准备页按独立 engine 选择读取环境：Claude Code 读取 `getSoftwareUpdates(false)` 的真实状态；Codex 的
  CLI、账号与项目配置依赖项目作用域，因此明确标为“项目后检测”，不提前宣告成功。完成引导只进入
  工作区，不擅自启动终端或触发登录；后续沿既有单一自动事务继续检测、补齐、发现、实测与保存。
- CSS 文件职责不变：业务外观在 `views/onboarding.css`，全部关键帧在 `04-motion.css`，720/1024
  响应式规则在 `07-responsive.css`。四主题继续由 `TerminalThemeShell → SHELL_CSS_VARIABLES` 一次
  覆写 UI/display/mono 字体、排版比例、色彩、圆角、阴影、时长和非线性曲线。

## 技术栈

- Electron 43：桌面窗口、系统托盘、目录选择与进程生命周期。
- TypeScript 6、Vite 8：主进程编译和渲染资源构建。
- `@anthropic-ai/claude-agent-sdk`：Claude 结构化消息、工具、权限、提问、计划、MCP、附件和中断；
  只调用显式解析到的用户安装 `claude.exe`，平台可执行包不进入发行物。
- `@lydell/node-pty` 1.2 beta：通过 Windows ConPTY 创建真实伪终端，并提供按平台预编译
  原生模块。
- xterm.js 6 + `@xterm/addon-unicode11` + `@xterm/addon-webgl`：终端渲染、键盘输入与中文
  宽字符计算；WebGL 渲染器负责大量输出时的绘制性能，丢失上下文时回退 DOM 渲染器。
- `@fontsource-variable/hanken-grotesk`、`newsreader`、`roboto`、`inter`：把四套主题需要的
  正文与标题字体随应用离线打包，全部为可变字重、无外部请求。
- `marked`（只使用 lexer token）、Shiki core + 精细语言包、KaTeX：安全 Markdown DOM、
  主题化代码高亮与公式；Shiki 的 Oniguruma WASM 和九种语法按 chunk 延迟加载。
- d3、Plotly、Mermaid、KaTeX：由 `claudedock-artifact://libs/` 作为 Artifact 离线资源提供，
  不注入宿主页面。
- Vitest、ESLint、Prettier：测试和静态检查。
- electron-builder + electron-updater：Windows NSIS 安装包、通道清单和 COS generic feed 应用内更新；
  GitHub Releases 只承担手动下载与发行历史。

依赖版本以 `package.json` 和 `package-lock.json` 为唯一事实来源。

### 本地品牌资产与法律文件

| 资源                                                  | 官方来源                              | Source SVG SHA-256                                                 | LF-normalized body SHA-256                                         |
| ----------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `src/renderer/assets/brands/claude-spark-clay.svg`    | <https://www.anthropic.com/press-kit> | `6D53DB4BE375E899C937C26CF16684A80D6E869B1928D72B37748BEF2560E219` | `1E3C6BD43F5B0598FF4452769410D0597AD0BE3FBDD043930DA664AF9E1FD39F` |
| `src/renderer/assets/brands/openai-blossom-black.svg` | <https://openai.com/brand/>           | `7BE72F1FEA831D3BA81A545CEE79B7E0AE69449D5D7837C9571CCBFB4AA1E00B` | `CC448BF8E40F2B83E6E559EA8BE816657740BC8305269E88EEC27FF710356941` |
| `src/renderer/assets/brands/openai-blossom-white.svg` | <https://openai.com/brand/>           | `B94EA61D860FAE6F82F43571F36F17111FCF5D348E8E9CC22AE4B441C7560011` | `834590F050BFC2F170BEAE54D432CDD2096C74AECEB8FD4D482DB76493EA4F02` |

三个资源均于 2026-08-24 从各自官方 archive 取得；SVG comment 记录 page、archive URL/entry、检索日期与
原始 hash。文件保留官方 geometry/fill，只允许安全 standalone SVG：不得包含 `<image>`、`<script>`、
event handler 或 `href`。Claude 使用固定 Anthropic light surface；OpenAI 按 appearance 使用 black-on-white
或 white-on-black，禁止 `currentColor`、CSS filter 和主题 token 重着色。`vite.config.ts` 将
`assetsInlineLimit` 设为 0，使三项作为 hashed local files 进入 renderer package。

根目录 `LICENSE` 与 `NOTICE` 在 electron-builder `build.files` 中逐字列出，并通过 package contract 和
最终 ASAR 检查验证；不得依赖 builder 的隐式默认行为。

## 架构与数据流

```text
Renderer (primary xterm.js / explicit native conversation DOM)
        ├── ConversationReducer ── revision / ordered content blocks / late-event rejection
        ├── Native interaction dock ── permission / question / plan / MCP / images
        ├── OwnedSessionOperationRegistry ── per-session operation / generation UI ownership
        ├── OwnedOperationRegistry ── application-global Codex install/account UI ownership
        ├── ClaudeLaunchAttemptRegistry ── preflight / starting / paused / 真实事件解锁
        │
        │ 受限 IPC
        ▼
Preload contextBridge
        │ 参数过滤
        ▼
Electron Main ── RuntimeProfile + AppPaths ── production / isolated-test capability gates
        ├── NativeConversationService ── ConversationAdapter lifecycle / exact UUID resume
        │        ├── ClaudeAgentAdapter ── user-installed claude command / Agent SDK
        │        ├── FakeConversationAdapter ── deterministic isolated integration scenarios
        │        ├── ConversationOwnerRegistry ── runtime + normalized project + UUID single owner
        │        ├── ConversationRecoveryStore ── atomic journal / DPAPI pending prompt
        │        └── NativeAttachmentStore ── magic bytes / dimensions / TTL / orphan GC
        ├── TerminalWorkspace ─┬─ TerminalSession ── node-pty ── PowerShell / ConPTY
        │                           ├─ TerminalSession ── node-pty ── PowerShell / ConPTY
        │                           └─ …
        │
        ├── AgentRuntimeStore ── 下一次新建使用的 Claude Code / Codex 全局偏好
        ├── SessionOperationCoordinator ── per-session PTY 变更租约 / 取消后等待 unwind
        ├── ClaudeRuntime ── 版本门禁 / 临时 settings / statusLine 指标
        │        ├── ClaudeConfigStore ── safeStorage / 下个对话 profile / 会话独立快照
        │        ├── ClaudeConnectionHistoryStore ── version 3 名称 / 协议 / 加密回放
        │        ├── ModelSpeedPreferencesStore ── 去凭据目标哈希 / 标准或快速偏好
        │        └── launch-owned Hooks ── 活动事件 / PermissionRequest named pipe
        ├── RuntimeActivityRegistry ── session / launch / PTY 代次隔离的任务状态机
        ├── RuntimeProcessRegistry ── PTY 后代 / TCP 监听 / 不透明终止键 / 退出清理
        ├── ClaudePermissionBridge ── 会话队列 / 600 秒 fail-closed 权限响应
        ├── ClaudeStreamDiagnosticsStore ── 14 天 / 200 条 / 2 MiB 脱敏流故障
        ├── CodexRuntime ─┬─ 官方 CLI 检测 / 工作区沙箱 TUI 启动
        │                 ├─ CodexInstaller ── GitHub Release / size + SHA-256
        │                 └─ CodexAppServer ── JSONL / ChatGPT 登录与账号额度
        ├── ClaudeSessionManager ── 当前项目 JSONL 元数据 / 定向恢复与删除
        ├── ChatConfigStore ── safeStorage / 全局独立对话配置
        ├── ChatHistoryStore ── version 2 block 历史 / Token 快照 / 附件引用回收
        ├── ChatAttachmentStore ── 文件校验 / 应用数据副本 / 主进程 base64 与缩略图
        ├── ChatService ── Anthropic/OpenAI 多模态 HTTP + typed SSE / usage / 测试 / 取消
        ├── ArtifactService ── 自定义协议 / iframe CSP / 离线库 / webRequest 审计与断网
        ├── BusyRegistry ── 下载/安装/卸载/配置/代理/对话的唯一忙碌租约真值
        ├── DownloadEngine + Journal/History ── 续传 / 进度 / 终态历史 / 完整性闸门
        ├── ApplicationProxyStore ── DPAPI / 外部 HTTP-SOCKS5 代理作用域
        ├── McpManager ── 多作用域发现 / CLI 变更 / 健康检查 / 备份回滚
        ├── WorkspaceStore ── 项目列表 / 最后激活项目的原子 JSON 持久化
        ├── ClaudeGatewayDetector ── 本机端口 / 安装 / Claude 设置只读发现
        ├── ManagedChatGptGateway ── CLIProxyAPI 验证下载 / OAuth 引导 / 回环 sidecar 生命周期
        ├── ClaudeRouterManager ── CCR 3.x 本机 RPC / Provider / 网关 / 安装与卸载
        ├── CcSwitchAdapter ── 官方 MSI / 注册表只读发现 / ccswitch 深链导出
        ├── ClaudePluginManager ── Claude CLI 插件目录 / 市场 / 安装与更新
        ├── SoftwareUpdates ── Claude Code / Router registry 版本检测与安装源
        ├── ApplicationUpdaterService ── COS 当前通道检查 / 显式下载 / NSIS 安装
        ├── WindowsCommand ── 原生命令及 npm PowerShell shim 的安全 argv 调用
        ├── ClaudeConnectionTest ── Anthropic /v1/messages 分阶段实测
        ├── CliCommandCatalog ── Claude / Codex 命令元数据、执行策略与主进程白名单
        ├── Tray 聚合状态与项目菜单
        └── 原生目录选择器、路径验证
```

### Claude 会话入口路由

- 新建主路径固定为 `project:open-conversation → createdSessionId/runtime → launchClaudeSession()` 或
  `prepareAndLaunchCodex()`。项目 `+` 的每次点击都取得精确 session ID 并启动独立后台续体；切换活动终端
  不会取消它。Codex 共享安装/登录等待由 Codex 与工作区状态事件唤醒，5 秒异步定时器仅作丢信号兜底。
  Claude 工作台的 continue/resume 与历史记录精确恢复仍复用同一 per-session 启动协调；
  成功后关闭原生可见层并恢复终端 fit/focus，失败则回滚精确临时终端。
- 次级路径固定为 `launchNativeClaude(mode) → native-conversation:start`。终端工具栏的“原生对话”是
  新建或重新打开 native owner 的唯一主界面入口；原生界面中的同一按钮显示“返回终端”，并复用既有
  加密草稿保全、精确 UUID 转移、附件保全和失败回滚事务；仅安全保存草稿不再额外要求确认。
- 第三条路径是接管：终端里已经跑着 Claude Code 时，同一个“原生对话”按钮走
  `adoptTerminalConversationIntoNative() → native-conversation:adopt-terminal → service.adoptFromTerminal()`，
  把当前这段对话原地搬进原生界面，而不是另起一段。按钮因此按终端是否有活进程分流：无活进程时
  退回 `launchNativeClaude('new')`，有活进程时才接管。`RuntimeActivitySnapshot` 的前台、等待、恢复、
  未完成 task 和运行/停止中的 Web 进程，以及原生 snapshot 的执行 phase 与未完成 task，都会先触发
  中断确认；renderer 预判负责及时反馈，主进程在停止 runtime 前复检并以显式 `allowInterrupt` 防止
  检查后状态变化的竞态。
- presentation route 与 permission mode 相互独立。终端优先不修改 `permissionMode` 默认值、
  `allowBypassPermissions` 项目门禁、SDK `canUseTool` 映射或主进程 owner contract。

### 原生会话不变量

- 新 Claude 会话在启动前预分配 UUID；JSONL 是正文唯一真值，恢复日志只增强异常中断的可发现性，
  不能补写尚未落盘的回复。`prepared → dispatched → transcript-confirmed → turn-complete` 各阶段原子
  更新；`safeStorage` 或日志写入失败时发送失败并保留 renderer 草稿。
- owner key 固定为 `(runtime, normalizedProjectPath, lowercase UUID)`。历史定向恢复、重命名和删除只用
  文件名派生 UUID；active/starting owner 从历史隐藏，runtime 失活后重新出现。已有 owner 的恢复只
  聚焦，不创建第二进程；返回安全终端的转移失败会恢复原 owner、草稿和原选择。
- `adoptFromTerminal` 的不变量与反向转移对称，但顺序不能颠倒：
  1. 先取 `terminalConversationOwners` 里那条 owner，它和 `prepareModelSpeedRelaunch` 依赖的是同一个
     真值——只有 Claude Code 在状态行上报过 transcript UUID 之后才存在。缺失或非法 UUID 时直接拒绝
     并提示稍候，因为此时“接管”只会分叉出一段全新对话。
  2. 归属校验必须跑在杀 PTY 之前。若终端并不持有这段对话，被拒绝的接管不得留下一个已经被结束的
     会话。
  3. 停的是标签页里的 Claude 进程，不是标签页本身：让它继续跑会出现两个写者同时写一份 JSONL，
     关掉标签页则会毁掉用户正在其中切换的那个容器。停止序列是
     `invalidateAndWaitForDevelopmentSessionOperation → terminateSession → workspace.stop → setInactive`。
  4. 启动只能是携带精确 UUID 的 `resume`，绝不是 fresh launch。
  5. 全程把 sessionId 放进 `terminalTransferSessions`；workspace 的 stopped/error 回调与 inactive
     project-state 发布都必须跳过 owner release，避免转移被误判成用户主动退出并让最终 commit 失去
     stopping owner。
  6. 失败回滚要把 owner 交还终端、用 `runClaudeResumeLaunch` 重启同一段会话，并释放
     `releaseNativeConversation(ownerId)` 与 `nativeLaunches`。连重启也失败时必须把两个失败都报给
     用户（提示手动重新启动），静默声称已恢复会让会话彻底搁浅。
  7. 成功后才 `terminalConversationOwners.delete(sessionId)` 并写入
     `nativeConversationSessions`，renderer 复用同一个终端标签页而不是新开一个。
- 结果未知的提交永不自动重发，避免重复工具操作、费用或外部副作用。仅当 JSONL 对账确认 user 记录
  已写入后才清理加密待确认文本。
- `ClaudeAgentAdapter.submit()` 在 SDK 输入队列同步接受 payload 后，以同一
  `clientSubmissionId` 发布用户消息，再进入 `running`；renderer 以
  `(conversationId, clientSubmissionId)` 持有提交锁，迟到确认只清理完全相同的文本和附件集合。
  SDK `result.is_error` 是可恢复的单轮失败：写入 system 失败消息后回到 `idle`。迭代器抛错或意外 EOF
  是流级失败：关闭 query/queue、撤销交互并从 adapter 删除 session；服务收到
  `conversation.error` 后同步释放 owner，主进程据失败快照释放路由预约。
- `ClaudeAgentAdapter` 用前台或 `parent_tool_use_id` 作为助手流通道；首个 `message_start` / delta
  为通道分配稳定显示 ID，后续 delta 和最终 `assistant` 帧复用它，最终 upsert 因而只把 streaming
  状态收口为 complete。没有 SDK UUID 时使用 adapter revision 与本地助手序号生成一次性回退 ID，
  禁止再次使用会随每个事件递增的全局 sequence。renderer 对 IPC 累计快照执行 revision/sequence
  单调检查，并用 `requestAnimationFrame` 合并同一帧内的更新；消息 article、label、body 与 block mount
  按 ID/type 持久复用，流式正文保留同一个 `Text` 节点并以 `appendData(delta)` 追加。完整正文才进入
  异步安全 Markdown renderer；提交结果前同时核对 article/block 身份、source、message status 与 render
  generation，迟到的旧 token、旧状态或已替换 block 都不能覆盖当前正文。
- Claude Agent SDK 的原生 `dontAsk` 会在 `canUseTool` 前拒绝所有需用户交互的工具，连 allow rule 中的
  `AskUserQuestion` 也不例外。ClaudeDock 因此把 SDK engine 保持在 `default`，但在 adapter callback 中
  复刻 `dontAsk` 的严格语义：未预批准工具立即 deny；只有当前用户 payload 明确包含选择题/选项意图时，
  放行一次 `AskUserQuestion` 并消费该例外，result 或下一次 submit 都会清除它。这不会扩大 Bash、编辑、
  MCP 或其他权限。UI 将该逻辑模式标为“仅预批准”，避免把权限确认与对话式选择混为一谈。
  这不构成比原生 CLI 更严的限制：SDK 只在 CLI 自己的权限引擎判定“需要询问”时才发
  `can_use_tool` 控制请求（payload 带 `matched_ask_rule`），被 settings 规则预批准的调用根本不会
  进入 callback；而 SDK 对 `dontAsk` 的定义本就是 “deny if not pre-approved”。该模式默认关闭、
  需经确认弹窗才能进入，终端侧同样限制它。
- **原生必须显式传 `systemPrompt: { preset: 'claude_code', type: 'preset' }`。** SDK 把省略该项
  当作“自定义空提示词”而非“沿用 Claude Code 的”（`sdk.mjs`：`if (s === void 0) d = ""`，只有
  `s.type === "preset"` 分支才交还 CLI）。官方文档亦明说 “This differs from `claude -p`, which
  uses the full Claude Code prompt by default”。`tools` 预设**不**蕴含 `systemPrompt` 预设，二者
  独立；漏传会让模型持有完整工具集却没有任何行为指令，表现为“同一模型在原生模式明显变笨”，
  且无报错、无告警。`tests/main/claude-agent-adapter.test.ts` 用精确相等（非 `toMatchObject` 子集）
  锁定该值，删除即失败。<https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts>
- 两条会话通道的模型可见行为必须对齐：终端在 `--settings` 文件里写 `skipWebFetchPreflight: true`，
  原生便通过 inline settings 层传同一项，否则同一个 WebFetch 请求会因为通道不同而被预检拦下。
  `settingSources` 显式传 `['user','project','local']` 虽与 SDK 默认等价，但 v0.1.0 曾短暂改为
  不加载任何文件设置后回退，显式传可防版本漂移。此类差异属于“用户没有选择过的额外限制”，
  发现即修，不留待讨论。
- `prepareNativeConversation()` 从项目 launch snapshot 读取默认开启的 `allowBypassPermissions`，通过
  service start input 传给 adapter；adapter 只在该门禁为真时设置 SDK
  `allowDangerouslySkipPermissions` 并发布 `bypassPermissions` 能力。主进程在运行中切换前重新读取项目
  开关，adapter 再做第二次校验；恢复日志不持久化这个高风险授权，不能用旧会话绕过当前项目设置。
- `native-conversation:start` 对路由预约、adapter 启动和 owner claim 按同一次启动事务回滚；新 UUID
  在 adapter 启动失败且没有正文时删除空恢复行，精确 resume 失败则保留原恢复入口。升级时还会把
  “无提交且无 canonical JSONL”的旧版空预约与真实历史对账并清理，不删除任何 Claude JSONL。
- `chatgpt-subscription` 的手动与自动连接测试在主进程先执行
  `ManagedChatGptGateway.ensureRunning()`。这只恢复 ClaudeDock 自有的回环 sidecar，不接管外部
  Claude/Codex/CCR；成功后才运行真实一 token 测试并替换旧健康快照。
- 隔离 profile 使用临时 userData/home/project、假适配器和内存终端，不获取生产单实例锁，不启动
  托盘、更新器、插件变更、外部路由写入或真实 PTY。所有危险入口在主进程再次检查 profile capability。
- Claude Agent SDK 解析器先查找用户可执行的 `claude` 命令。直接安装返回 `claude.exe` 时原样使用；
  NPM 的 `claude.cmd` / `claude.ps1` 启动器则只解包到同一安装目录下
  `node_modules/@anthropic-ai/claude-code/bin/claude.exe`，并在文件不存在时给出可执行的重装诊断。
  ClaudeDock 不下载、不复制，也不随安装包携带第二份 Claude Code。
- `FakeConversationAdapter` 的完整场景按固定顺序发出文本、工具成功/失败、图片、任务、用量以及
  permission/question/plan/MCP 请求；renderer 的交互坞只消费队首请求，响应后才显示下一项。
  这条 FIFO 约束既避免卡片堆叠，也让每个 SDK 响应只匹配当前可见请求。

### 流式路径的复杂度契约

`includePartialMessages: true` 让每个 token 增量都是一个事件。凡是在这条路径上按整份 transcript
做 O(N) 工作的写法，在 10 条消息时无感、在几百条消息时会让整个应用卡死；下列约束都是为此存在的，
放宽任何一条都会把同一个故障带回来。

- `reduceConversationEvent` 只做结构共享：事件碰到哪个数组或对象就复制哪个，其余消息保持同一引用。
  禁止在 reducer 里深拷贝整份 transcript——它每个 token 跑一次，既吃主进程 CPU，又按整份 transcript
  抬高快照跨进程结构化克隆的代价（主/渲染两侧各付一次）。
- `ConversationMessageView.version` 由 reducer 独占维护，adapter 不设置：每次消息变化 +1，且跨
  delta/`tool.updated`/upsert 连续递增而不重置。renderer 靠它 O(1) 判断“这条消息变了吗”；退回按内容
  序列化比较等于每帧 `JSON.stringify` 整份 transcript。
- 主进程用约 50ms 的合并窗口发布快照，同一对话只保留最新一份。`idle`/`failed`/`stopped`/
  `requires-action` 四个终态绕过定时器立即发送，因为 renderer 要在这些相位释放排队输入和拆除 owner，
  迟到会表现为界面卡住不动。
- renderer 重排消息 article 和内部 block 都用就地 `insertBefore` 对齐，不用
  `replaceChildren(...)`：即使传回同一批节点，后者仍会全部摘除再插入，等于每个流式帧让整份
  transcript 或整条消息的布局失效。article、label、body、caret 与按 block ID/type 建立的 mount
  必须保持身份；同 ID 类型变化时只替换该 block，不重建无关 sibling。
- 流式 text block 保留同一个 `Text` 节点。新正文以前一正文为前缀时只执行 `appendData(delta)`；
  同长度修正、截断或任意非前缀变化才写回完整文本。tool tick 只原地更新对应 tool block，不能重建
  整条消息，也不能让未变化的已完成 Markdown 再次 lex 或高亮。
- 完成态 Markdown 只在 source 或 message status 真正变化时异步解析；提交 fragment 前必须核对 article
  state、block state、source、status 与 render generation。失败保留纯文本，旧 promise 不得覆盖更新后的
  source、类型已变化的 block 或已删除的消息。
- 强制同步布局的代码（写 `--native-composer-h` 后再 `getBoundingClientRect()`、排队条重绘）必须先比
  签名或缓存值再决定是否执行，不得挂在流式渲染路径上。runtime summary、native footer controls 与
  resource footer 只按实际显示字段组成 presentation key；正文、revision/sequence、interaction 和未显示
  时间戳不得让它们失效。`.native-message` 用 `content-visibility: auto` +
  `contain-intrinsic-size` 把滚出视口的消息移出布局与绘制。
- adapter 在入库前把工具入参与结果截断到 `TOOL_OUTPUT_CHARACTER_LIMIT`（32000 字符）并标注省略字数。
  工具结果留在 block 里，会随之后每一份快照重发、并在该消息每次重绘时重新序列化；一次大文件 `Read`
  就足以让后续每帧变成兆字节级工作量。完整内容仍在磁盘 JSONL 上，这个上限只约束 UI 携带的副本。
- 对话关闭时必须从 `nativeConversationSnapshots` 删除对应条目，否则每段对话都会把整份 transcript
  泄漏到进程结束。

### 原生视觉与组件门禁

组件外观、三层令牌、六级字体角色、原语、布局分组、四主题人格和 720/1024/1280 响应式边界以
`design.md` 的“设计系统：单一事实源”为准；本文件只记录会影响状态、IPC、top layer 或验证环境的接线。

- 项目页不实例化 `#status-pill/#session-detail/#session-pid`；`renderActiveStatus()` 只更新标题栏、底栏、
  终端空态和 runtime 控件，错误仍由 `showTerminalDiagnostic()` 按 session generation 去重弹出。
- `#native-composer` 是 Claude/Telegram 共用的提交与附件内核。它只有一个动作按钮 `#native-send`：
  `data-action` 在 `send`/`stop` 之间切换，`data-sending=true` 只在发送确认动效期间短暂存在并在
  `animationend` 后清除，`data-stopping=true` 只在真正按下中断后出现。动作切换绑定动效结束而不是
  IPC 回调，保证按钮面孔和用户看到的画面一致。运行中输入的内容进入 `#native-queued`（`role="status"`、
  `aria-live="polite"`、`data-state` 取 `queued`/`dispatching`），它排在发送行之上、附件队列之外，
  每个对话至多一条。submit IPC 为保持 provider route lease 会等到整个前台回合结束；一旦快照已进入
  `running/stopping`，这个待决 promise 不得继续禁用 composer、附件或 stop，新的输入只进入排队条。
  旧 submit 的迟到完成只能清理自己的提交锁；若已有较新的 queued entry，不得删除它的 auto-flush
  意图。输入坞实测高度写入 `--native-composer-h`，toast 消费该值避开输入操作区；排队条出现或消失
  都要重新测量，但重绘前先比对签名，避免每个流式帧都触发同步布局。主题图形与减少动态效果行为由
  设计系统样式负责。
- `npm run test:control-theme`、`npm run test:select-theme`、`npm run test:select`、
  `npm run test:dialog-select`、`npm run test:layout`、`npm run test:scroll-chaining` 和 `npm run test:visual` 分别验证控件主题、增强
  select、top-layer dialog、命中/重叠、嵌套滚动链和四主题截图。真实窗口证据由
  `npm run test:visual:real` 写入 `dist/visual-qa/`；隔离 profile 不连接真实会话、PTY、凭据、更新器或外部路由。

### 滚动链与遮罩（platform/scroll-chaining.ts）

- 全应用只有一条垂直滚动链规则。`installScrollChaining()` 在 `main.ts` 模块作用域、
  `bootstrapApplication()` 之前幂等安装，并返回幂等 disposer；同一 `Window` 重复安装不会叠加 listener，
  `beforeunload`、显式 dispose 与再次安装都清理待执行 RAF 和旧 burst。
- **必须是 JavaScript，不能只靠 `overscroll-behavior: auto`。** Chromium 会把 wheel burst latch 到起始
  scroller，子级到边缘后不会可靠把 residual delta 交给祖先。监听器因此在同步阶段只筛选事件、快照
  composed path、更新 burst 时钟、`preventDefault()` 并入队；不在 wheel handler 中读取布局。
- 下一次 `requestAnimationFrame` 严格按 read → compute → write 执行：先一次读取本帧候选几何与 computed
  style，再按事件顺序用虚拟 `scrollTop` 把完整 delta 从 child → parent → outer 分配，最后每个连接目标
  只写一次该帧插值位置。某层只消费自身容量，余量同帧继续向外；向上完全对称，双层与三层以上均保持
  `consumed + residual = input`，同帧多事件也不互相覆盖。目标是 handoff 不超过一帧、可测环境下 wheel
  handler p95 小于 2ms。
- `platform/motion.ts` 定义 180ms、`1 - (1 - t)^3` 的非线性减速。滚动链在原有同一个 RAF 中维护
  逻辑终点与绘制位置；追加 tick 按逻辑终点分配，不能拿尚未完成的插值位置重新计算而吞掉输入。
  第一帧即推进子级和父级，之后逐步减速；原生滚动条随真实 `scrollTop` 同步，不另画滑块或叠加滚动器。
  xterm 使用其原生三次缓动实现，通过 `smoothScrollDuration` 采用同一时长，不接管已经被终端消费的 wheel。
  导航到字段、步骤、标签页和下拉选项使用浏览器非线性 smooth scroll。状态恢复、输出追加及直接拖动
  不附加延迟；`prefers-reduced-motion` 同时关闭 JS 缓动与 xterm 缓动，销毁视图时解绑监听。
- burst idle 不是固定 200ms：首对 tick 后按真实间隔的指数移动平均计算 64–320ms 自适应窗口。方向反转
  立即取消余下惯性并开新 burst，从当前 child 重新向外分配；同方向且新事件路径包含原目标时保持已到达的
  祖先，避免新滑入光标下的卡片抢 tick，也不抢另一面板的输入。原生拖动、键盘操作、程序恢复位置或打开
  模态层会解除相应旧动画和 latch；迟到的动画不能把用户拉回旧位置。
  原生 `scroll` 通知可能晚于下一次 wheel 到达，因此只取消旧动画、重置待分配路径，不清空新排队的输入。
  普通断开节点安全跳过；入队时快照到的 open dialog、`:modal`、`:popover-open` top-layer 边界即使随后
  断开也继续封闭背景。
- `overscroll-behavior-y: contain | none` 是硬边界，但元素先消费自己的可用容量；增强 select 的
  `.select__listbox` 由此可滚且不会把尾部带进外壳。连接历史卡片取消固定高度和自身 `overflow-y`，真实
  页面只保留历史列表 → 控制面板两层，平台算法继续支持任意更深嵌套。
- 每个模态遮罩只允许 `dialog::backdrop` 一条规范规则，取 `var(--mask-veil)` 与 `var(--mask-blur)`
  两个按主题定义的令牌，由 `shell/theme.ts` 在每次换主题时行内改写，因此"契合各主题"与"随时变色"
  都不需要额外接线。`tests/renderer/design-tokens.test.ts` 禁止任何 `::backdrop` 硬编码颜色，并要求
  规范规则恰好一条——此前 `rgb(0 0 0 / 58%)` 能通过门禁，是因为中性色判定豁免了全 0/全 255 通道。
- 增强 select 弹层自身能滚动，依赖 `positionListbox()` 在清空 `max-height` 量测前后保存并回写
  `scrollTop`：清空的那一瞬间浏览器看到一个无可滚动内容的盒子，会把 `scrollTop` 夹回 0。同时
  `installSelectDismissHandlers()` 的 capture 期 `scroll` 监听要跳过源自弹层内部的滚动——`scroll`
  不冒泡但会 capture，弹层滚自己也会触发重新定位，从而与用户抢滚动条。两处缺一，弹层都滚不动。
- `tests/renderer/scroll-chaining.test.ts` 以注入 probe 覆盖守恒、双向 residual、三层以上、方向反转、
  adaptive burst、断开节点、重复 install/dispose、缓动重定向、原生拖动、减少动态效果与 top-layer containment。
  真实几何、trusted wheel、非线性中间帧、单帧 handoff 和 handler p95 由 `npm run test:scroll-chaining`
  验证。夹具先计算目标与所有裁剪祖先的可见交集，并核对 `elementFromPoint`；不能将屏幕外坐标直接
  截到窗口边缘，否则滚轮实际落在外层却被误报为子列表失败。smoke 必须 `show: true`；隐藏窗口会
  静默丢 tick。`sendInputEvent` 使用 Windows WM_MOUSEWHEEL 符号，`deltaY: -120` 是向下，与 DOM 相反。

### 模型能力与呈现

- `ModelCapabilityProfile` 的身份至少包含 runtime、provider、endpoint、模型族和 CLI/网关版本；
  结构化运行时元数据优先于验证目录与隔离探测，未知能力 fail-closed。renderer 只消费同一 revision
  的 `ModelControlState`，防止模型、effort、Fast、图片和权限控件跨版本拼接。
- Claude `ultracode` 是请求预设，收起控件只呈现“Ultra Code”，展开说明与辅助技术描述再显示
  “工作流编排 · 实际 X-High”；applied `xhigh` 不得覆盖 requested preset。Fast 是互斥状态而非倍率承诺。Codex Ultra 以后接入同一能力层，
  但 5.0 RC 不通过实验性 App Server 驱动真实会话。

### 设计系统跨文件耦合（关键约束）

以下值必须跨文件同步，不一致会导致视觉错位或色块跳变：

- **`--titlebar-h` (48px)** ↔ `src/main/app/window.ts:83` / `:102` `titleBarOverlay.height`（两处：
  切换主题与创建窗口）
- **`--toolbar-h` / `--footer-h` / `--composer-h`** ↔ `.terminal-shell` 网格行 ↔
  `.workbench-scrim` / `.claude-workbench` 的 `top` / `bottom`。`--composer-h` 由渲染层实测输入框
  高度后写回，抽屉的 `bottom` 是 `calc(var(--footer-h) + var(--composer-h))`；输入框自动增高时
  抽屉底边随之上移，不会盖住输入框。
- **`--surface-canvas`** ↔ `src/main/app/window.ts:80` `setBackgroundColor` / `:93`
  `backgroundColor` ↔ `body` 背景色
- **`--surface-1`** ↔ `src/main/app/window.ts:82` / `:101` `titleBarOverlay.color` ↔ `.titlebar` 背景色
- **`--text-hi`** ↔ `src/main/app/window.ts:84` / `:103` `titleBarOverlay.symbolColor`
  （Windows 标题栏按钮颜色）

#### 主题令牌桥

主题的作用域是**整个外壳**，不只是 xterm palette。`src/shared/ui/terminal-themes.ts` 的每套主题
除 `palette`（22 个 xterm 字段）外还有 `appearance` 与 `shell`（颜色、字体、排版、动效、
形状、按压和遮罩字段），
`SHELL_CSS_VARIABLES` 是「shell 字段 → CSS 自定义属性」的映射表，是这套机制唯一的接线点：

1. `applyTerminalTheme`（`src/renderer/main.ts`）遍历映射表写
   `documentElement.style.setProperty(...)`，并设 `dataset.theme`、`dataset.appearance` 与
   原生 `colorScheme`；`src/renderer/styles/**` 里所有 `var(--…)` 因此一起切换字体、表面、交互层、
   阴影和语义状态色。启动时以 `announce = false` 调用一次。
2. 原生窗口边框由 Windows 绘制，CSS 到不了，所以渲染层再调 `ui:set-theme` IPC；主进程
   `applyWindowTheme`（`src/main/app/window.ts:78`）执行 `setBackgroundColor` + `setTitleBarOverlay`。
   **只改 CSS 会留下用户看到的那圈深色边框。**
3. 主题 ID 存进 `WorkspaceStore`（`StoredWorkspace.terminalTheme`，version 仍为 1，
   `load()` 用 `isTerminalThemeId` 校验）。`createWindow()` 在第一帧之前读它决定初始
   `backgroundColor` / `titleBarOverlay`，冷启动不会闪出错色外框。

新增主题只需补 `shell` 字面量；新增可主题化的属性需要同时补 `TerminalThemeShell` 字段、
`SHELL_CSS_VARIABLES` 条目和 `styles/01-tokens.css` 的 `:root` 默认值。
`tests/renderer/design-tokens.test.ts` 会检查桥接字段、默认值与消费者三者齐全，并扫描整个拆分样式树的
未定义变量、旧尺寸字号令牌、selector 所有权、字面颜色/字体/字号/时长、keyframes、viewport media、
唯一 reduced-motion 块、六级字体角色和四主题对比度。视觉取值与组件规则不在此重复，统一见
`design.md` 的“设计系统：单一事实源”。Shiki 只判别 token 色相类别，最终写成 `--syntax-*` 变量，
因此已经渲染的代码也能即时换主题。

#### 标准组件套件

视觉原语与状态矩阵见 `design.md`；实现层保留以下不可由 CSS 取代的契约：

- `enhanceSelect()` 隐藏原生 `<select>` 的视觉呈现，但原生元素仍是取值、校验、焦点、键盘和事件的
  唯一事实来源。提交选择时写回 `select.value` 并派发真实 `change`/`input`；`MutationObserver`
  同步代码直接赋值、disabled 变化和动态 `<option>`。
- `.select__listbox.popover` 使用 `position: fixed`。普通页面每次打开时挂到 `body` 以逃离滚动容器和
  clipping；触发器位于已打开 modal dialog 时必须改挂到该 dialog 的 top-layer 子树，否则页面外元素
  的 inert 状态会让仅靠 `z-index` 的弹层不可命中。滚动和缩放重新定位，触发器消失时关闭。
- `hidden`、`data-open` 与 `aria-expanded` 同步翻转；JavaScript 不等待退场计时器，也不维护
  `data-closing`。`styles/05-primitives.css` 通过 `@starting-style`、离散 `display` 过渡和关闭态
  `pointer-events: none` 完成视觉退场，可访问性状态不被动画延迟。
- 透明原生 select 与 `aria-hidden` trigger 共用同一 `.select` 矩形。`scripts/smoke/layout-smoke.cjs` 只对
  同一 shell 合并命中与矩形相交结果；不同 shell 仍必须作为独立控件接受重叠检查。
- Checkbox/radio 的状态保留在原生 input；`installPressRipples()` 只为主要操作附加瞬时节点，
  `RIPPLE_SELECTOR` 与 `styles/05-primitives.css` 的目标规则互为镜像，减少动态效果时不生成节点。

#### 终端输出与输入的性能路径

- xterm 在 `createTerminalView` 里 try/catch 加载 `@xterm/addon-webgl`，并监听
  `onContextLoss` → `dispose()` 回退 DOM 渲染器。加载失败不影响会话可用性。
- **主进程侧合并**：`TerminalOutputBatcher` 按 session 与精确 `ptyGeneration` 攒 8ms
  （`TERMINAL_OUTPUT_FLUSH_MS`）或 64KiB UTF-8 字节（`TERMINAL_OUTPUT_FLUSH_BYTES`）发一次
  `terminal:data`。每个 session 只有一个带 generation 的待发缓冲：较旧 generation 的新数据直接忽略，
  较新 generation 才能替换旧缓冲。timer 闭包固定捕获 generation 与缓冲对象身份；即使已取消的旧
  timer 被手动触发，也不能 emit 或删除替代缓冲。自然 `stopped/error` 在发布 workspace 状态前同步
  flush 该 generation 的末尾缓冲；显式替换、直接控制与删除 session 仍只 discard，不能把 predecessor
  输出送进新终端。flush 同时检查缓冲身份、expected generation 与 workspace 当前 generation；
  `consumeTerminalOutput` 仍逐块调用——它跨块跟踪退出标记，合并后的缓冲会导致漏判。`before-quit`
  dispose 全部 timer 和缓冲。
- **渲染层侧无损泵**：`TerminalOutputPump` 按 `requestAnimationFrame` 合并待处理工作，但每个
  `TerminalView` 同一时间只允许一个 `terminal.write` 在途；每次最多提交 64Ki 个 UTF-16 code unit，
  且不会在代理对中间切分。实时输出不再设置 512KB 截断，也不丢弃最旧分块；队列只有在 xterm 的
  write callback 确认解析完成后才消费，只有完整 IPC revision 全部应用后才推进
  `appliedRevision`。`TerminalView` 固定拥有创建时的 `ptyGeneration`，排队、RAF 与写入完成回调都
  复核 view 对象和 generation；替换视图后，迟到回调不能消费、报告 probe 或推进新视图。主进程在
  发送 permission-mode probe 前还会先同步 flush 同 generation 的待发输出，renderer 再以 revision
  屏障等待此前屏幕差量全部进入 xterm。
- **创建与持续布局分流**：活动 xterm 的容器在 `terminal.open()` 前就带
  `project-terminal--active`。`retryTerminalFitUntilMeasured` 只在冷启动/首次可见时用带
  generation 的四帧有界重试；窗口与分隔条的持续变化走 100ms 尾沿
  `debounceTerminalFit`。拖拽期间只记 dirty，释放后一次 fit；`ResizeObserver` 对相同整数
  宽高短路。`terminal:size` 无条件回传最终尺寸，xterm 还从 `os.release()` 获得 ConPTY build
  hint，避免内部重复 reflow。
- **主题从 spawn 生效**：`TerminalWorkspace.setTheme()` 只更新后续 start/restart 使用的
  当前主题，不向运行中的 PowerShell 注入命令。`buildPowershellStartup()` 把 palette 转成
  PSReadLine 24-bit ANSI；`ClaudeRuntime` 的临时 `settings.json` 同步写 `light/dark`。
- **全局指针捕获收口**：两个宽度分隔条共用 `activeResizeCleanups`。正常抬起、系统取消、
  `lostpointercapture`、窗口失焦、页面隐藏和重新聚焦都会调用幂等清理，显式
  `releasePointerCapture` 并移除 `body.is-resizing`。这是窗口内所有按钮、下拉框、textarea
  偶发同时失去命中响应的统一修复边界。
- **确认框不越过 renderer 焦点边界**：Electron/Chromium 在 Windows 关闭原生 JavaScript
  `alert` / `confirm` 后存在 DOM 控件无法重新获得焦点的问题；xterm 的中文组合输入又依赖
  隐藏 textarea，因此会出现“英文原始按键仍可输入，但中文和主输入框都卡住”的不对称症状。
  renderer 统一用本地 `<dialog>` 实现二次确认，关闭后在下一绘制帧恢复打开前的控件，
  不再调用原生 JavaScript 对话框。
- **激活时状态自愈**：窗口重新获得焦点或页面从后台变为可见时，renderer 除了重新适配 xterm
  外，还通过 `getWorkspace()` 获取一次主进程真值并重新渲染。这样即使隐藏/恢复期间漏掉阶段
  事件，主输入框也不会因旧的非 `running` 快照长期保持 `disabled`。
- 输入框的 `Ctrl+A` / `Shift+←→` / 拖选 / `Ctrl+Z` / IME 全部是 `<textarea>` 原生行为，
  **没有对应代码**。需要实现的只有发送、历史与自动增高，见
  `src/shared/conversation/composer-input.ts` 与 `src/shared/conversation/composer-history.ts`。
  `buildTerminalSubmission` 用 `\x0a` 连接多行、末尾补 `\r`，与 `terminal-session.ts` 里
  PSReadLine 的 `Ctrl+j`(AddLine) 绑定成对存在：改一处必须改另一处，否则多行提示词会被
  逐行当成独立命令执行。输出区内的 `Ctrl+A` 由 `attachCustomKeyEventHandler` 映射到
  `terminal.selectAll()`（否则会被 PSReadLine 解释成「移到行首」）。

### 关键取舍

- **拒绝 Win11 `backgroundMaterial: 'mica'/'acrylic'`**：半透明桌面色调与需要接近纯黑对比度的终端直接冲突，且在非 Win11 上降级不可预测。
- **遮罩冻结视觉、不冻结输出**：`beginTerminalMask()` 复制当前 canvas；只对快照做 CSS blur，
  veil 与标签走主题 token。真实 xterm 在下层继续 `write()` 并推进输出 revision，所以权限模式
  probe 不会超时；幂等引用计数 disposer 在所有操作的 `finally` 释放。禁止使用
  `backdrop-filter` 或暂停队列。
- **输入用 `<textarea>` 而不是在 xterm 里做行编辑**：`Ctrl+A`、`Shift+←/→`、拖选、`Ctrl+Z`、
  IME 全部由浏览器免费提供且行为正确；在终端画布里模拟它们意味着自己实现一个编辑器，
  并且要和 PSReadLine 抢同一批按键。代价是终端不再是唯一输入入口，需要为 Claude Code 的
  TUI 保留直接聚焦输出区的能力。
- **主题存在主进程而不只在 `localStorage`**：原生窗口边框在第一帧就要有颜色，此时渲染进程
  还没运行，只靠 `localStorage` 一定会闪一下错色外框。

## 渲染进程与 IPC

- 渲染进程不启用 Node.js，只能调用 preload 暴露的固定方法。
- 主进程验证 IPC 发送方、会话标识、字符串长度、终端尺寸和目录是否真实存在。权限模式只接受
  六个已知取值，思考程度只接受 `CLAUDE_EFFORT_REQUESTS` 里的七个取值，模型选项 ID 只接受
  `current` 或 `history:<id>` 形态，重启入参逐字段校验；
  这些值最终都会影响启动命令或写进运行中的终端，所以一律在主进程重新核对，不信任 renderer。
- `TerminalWorkspace` 维护项目 ID、活动项目和多个 `TerminalSession`；每个会话拥有独立 PTY。
  `TerminalSession` 从 generation 0 开始，只在一次真实 spawn 尝试前递增一次；`stop()` 保留
  generation，`restart()` 先停后启但只因新的 spawn 递增一次。状态、输出、尺寸、写入、resize、
  permission probe 与停止请求都携带精确 generation，`stopIfGeneration()` 和 generation-aware
  `write()` / `resize()` 对旧实例直接拒绝。node-pty 的 data/exit callback 还要同时匹配当时捕获的
  `IPty` 对象，防止旧 ConPTY 回调在 session ID 已复用时污染新进程。
- `TerminalWorkspace` 构造出来是空的，也允许一直是空的：会话总是属于用户选定的文件夹，
  冷启动和关掉最后一个对话之后都没有活动会话。`getActiveStatus()` 因此返回
  `TerminalStatus | undefined`，`OperationResult.status` 也是可选字段，渲染层要判空。
  用 `homedir()` 兜底会造出一个以 Windows 用户名命名、用户从没打开过的项目。
- `TerminalWorkspace.emitState()` 在每次广播前递增应用生命周期内的 `WorkspaceState.revision`；同步
  `getWorkspace()` 返回当前 revision。renderer 保存已接受的最大值并丢弃更小的快照，防止并发
  `openConversation()` 返回顺序与创建顺序不同时，旧响应删除较新会话。活动 session 变化不再全局
  invalidate Claude launch preflight；只在精确 session 消失、generation 过期或用户取消时结束该启动。
- `StartupModelConnectionCoordinator` 在 main 中持有整次冷启动模型恢复。`TerminalWorkspace.openBackgroundSession()` 只创建一个 stopped 的事务 owner：不 spawn ConPTY、不改活动 session、不进入 workspace snapshot，也不消耗可见的“对话 N”编号。它复用 `SessionOperationCoordinator` 和 `runClaudeProjectConfigTransaction` 的 abort/rollback 边界完成真实连接测试，只在 `assertActive()` 仍有效时把经验证 profile 提升为“下个对话接入”。
- coordinator 状态包含 strictly monotonic `updatedAt`、`cancelAvailableAt`、`forceStopAt`，以及短步骤
  `step` 和可选的 renderer-safe `accountLabel`。启动恢复依次发布“读取配置 / 准备接入与网关 /
  网络预检与连接验证 / 提交接入配置”；官方 Claude/ChatGPT 订阅只显示 provider 与白名单账户标识，
  不返回令牌或原始 CLI JSON。preload 先订阅事件再读取快照，renderer 丢弃旧 `updatedAt`，因此页面
  切换或迟到 invoke 都不会倒退阶段。用户取消、硬超时和受控退出都 abort 同一操作，并等待 lease
  completion 后才发布 `cancelled/timed-out`；任何失败都保留原 profile、释放 BusyRegistry 租约与临时
  owner。`AppPreferencesStore` 对旧 version 2 数据补默认 2/5 分钟，IPC 重新校验 1–30 / 2–60 整分钟
  范围及 `force > cancel`。
- PTY 输出携带会话 ID 推送到渲染进程，并写入对应 xterm.js 实例；只有活动实例可见。
- 添加目录会记住该项目并创建首个会话；同一路径可由项目层级继续新开多个独立对话。每个 session 在
  创建时把 `AgentRuntimeStore.getNext()` 捕获为不可变 runtime，`getDevelopmentRuntime(sessionId)` 只返回
  该会话值；全局选择的后续变化不会改写同目录兄弟会话。
- `directory:choose` 从 IPC sender 解析真实所属 `BrowserWindow`，并仅在活动 cwd 仍是可访问
  目录时把它设为 `defaultPath`，否则回退到用户目录。带父窗口的原生对话框若因 Windows
  owner handle 状态失败，会无父窗口重试一次；失败原因通过结构化结果返回，不与后续
  `project:add` 错误混淆。
- 切换项目不重启 PTY；关闭项目才会终止对应进程，且不会影响其他会话。
- `WorkspaceStore` 把已添加项目、最后激活路径与所选主题保存到
  `userData/claude/workspace.json`。写入采用临时文件加重命名；启动恢复不会改写原来的
  最后激活项，项目切换和关闭后再同步状态。`terminalTheme` 是可选字段，`load()` 用
  `isTerminalThemeId` 校验后才采用，因此写入未知主题 ID 只会回退到默认主题而不破坏文件，
  version 保持 1。
- 托盘从 `WorkspaceState` 计算错误/运行聚合图标、运行数量和项目切换菜单。

### 会话启动互斥与事件锁

- `SessionOperationCoordinator`（`src/main/coordination/session-operation.ts`）按 workspace session
  串行化会重启或写入 PTY 的 Claude/Codex 启动、历史恢复、模型/速度重启和受管 ChatGPT 切换。
  `run()` 交给回调一个 `assertCurrent()`；它同时核对 generation、取消标记和 session 是否仍存在。
  `invalidate()` 只标记取消，**不会提前删除 lease**；lease 必须保持 busy，直到旧异步回调在
  `finally` 中真正 unwind，之后替代操作才能取得所有权。
- 终端 stop/restart、项目关闭/忘记与开发引擎切换会取消对应操作；关闭或忘记项目还会等待
  `invalidateAndWait()` 完成后才删除 runtime session。`runDirectTerminalTransition` 对直接
  start/restart/stop 固定执行七步，顺序不能交换：
  1. 在改变任何状态前预检 renderer 提交的 expected generation；
  2. invalidate 当前 per-session 操作并取得它的 unwind Promise；
  3. 立即解除只属于 expected generation 的 permission probe；
  4. await 被取消 lease 真正 unwind；
  5. 再次核对 workspace generation；
  6. 只 discard expected generation 的输出，并只把绑定该 generation 的 Claude/Codex runtime 设为
     inactive；
  7. 在 `withoutTerminalOperationInvalidation` 中同步执行 PTY start/restart/stop。
     probe 必须在 await 前解除，因为旧操作可能正等待 renderer 回报该 probe 才能 unwind。入口预检失败
     不做 invalidate 或 cleanup；等待期间若出现替代 PTY，第二次检查也会在 cleanup 和 PTY mutation 前
     取消请求。`enteredTerminalFailure()` 只把某一 generation 第一次进入 `stopped/error` 视为真实
     转换；重复状态快照不会再次取消操作，真实失败只按同一 generation 对账 runtime。
- `ClaudeRuntime` / `CodexRuntime` 在 prepare 提交点清空旧绑定，由 main 在 restart 返回后调用
  `bindPty()` 绑定唯一 generation。启动命令、退出标记、permission probe、Shift+Tab、模型/思考命令
  与 `/compact` 都只经绑定 generation 写入；每个异步边界后再次核对 ownership。命令正文和 40ms 后
  回车分两次写时沿用同一捕获 generation，替代 PowerShell 出现后迟到回车会被丢弃。失败清理只调用
  `workspace.stopIfGeneration(sessionId, ownedGeneration)` 与 runtime 的精确 `setInactive()`，旧启动的
  `catch/finally` 不能停止或清空新启动。
- Claude 启动预检协调器可为精确 `LaunchPreflightIntent + predecessor ptyGeneration` 建立一次性预期
  PTY 替换。作用域只同步包裹 `workspace.restart()`；workspace observer 只能消费第一条完全匹配的
  `predecessor → replacement` 边，并仅跳过该 intent 的失效。所有 generation change 仍使 launch health
  失效；错误 predecessor、作用域外变化、第二条变化和 `stopped/error` 边仍使 intent stale。
  `beginLaunch()` supersede、session/global invalidation 与 restart 异常都必须清除未消费 expectation，
  禁止跨启动泄漏。restart 返回后才记录 owned generation、检查 intent、绑定 PTY 和写命令，因此后续
  失败仍只停止本次替代 generation 并中止精确 prepared token。
- Claude 启动在进入任何异步预检前同步建立或复用 canonical inactive runtime，并把不含凭据的对象身份
  纳入 launch baseline。renderer 为展示状态并发调用 `getState()` 只能复用同一 owner，不会再把正常读取
  误判成外部更新；真正关闭后即使同一 session ID 被重建，identity 变化仍会使旧启动失效。baseline 断言
  本身只读，不能为了比较而复活已关闭的 runtime。
- 普通 UI 不再调用项目级 `runtime:set`。`runtime:get-next` / `runtime:set-next` 读写一个原子持久化的全局
  “下一次新建”偏好；新 session 在同步分配时捕获它，因此一次已被接受的点击不会被稍后的选择改换引擎。
  `runtime:get` 按 session 回读实际 runtime。旧 `ProjectRuntimeSwitchCoordinator` 与 `runtime:set` 只保留为
  兼容/高级诊断路径，不参与普通新建交互。
- renderer 的 `ClaudeLaunchAttemptRegistry`（`src/renderer/platform/claude-launch-attempt.ts`）按 session 保存
  generation、初始 conversation UUID、Claude active、PowerShell PID 与精确 `ptyGeneration`。点击主入口
  或任何 relaunch 在第一个 `await` 前登记并立即重绘 `disabled`/`aria-busy`；冷状态第一次观察只建立
  baseline，不把已有 UUID 误判成新会话。确认、prepare、IPC settlement 与结果应用都通过同一 token
  的纯 orchestration；旧确认恢复或旧 IPC 拒绝不能发起请求、toast、刷新控件或改写替代尝试。
- IPC 成功返回不释放 renderer 锁。只有新的 conversation UUID、新的运行中 `ptyGeneration`（即使
  Windows 复用同一 PID）、新的运行中 PowerShell PID、已观察 active 后变 inactive 且 PowerShell
  仍运行，或明确 IPC 失败、terminal `stopped/error`、session 删除时才释放。删除会话同时裁剪对应
  launch-result tombstone，避免长期创建不同 session 造成无界增长。这里故意没有 timeout：超时不能
  取消仍在 main 执行的 restart，提前解锁反而允许重复启动。Codex 保留独立 renderer 启动状态。
- 终端 start/stop/restart 由 renderer registry 按精确 session generation 持有；自动启动也必须调用同一
  owner，main 的 `starting` snapshot 可在 reload 后重建“正在启动…”，失败状态不能留下延迟 focus intent。
  runtime switch 的最终 owner 是上述 main CWD coordinator，renderer token 只派生同目录呈现。
- Codex installer、browser/device login、cancel 与 logout 在 main 中共享应用级单例。`CodexProjectState`
  暴露单调 `revision` 和 sanitized `{ attempt, kind }` active operation；main 在异步诊断前预留 owner，结束时
  先以更高 revision 清除并向全部项目广播。renderer 的 optimistic token 只在没有更新 main descriptor 时生效，
  reload 恢复精确文案、disabled 与 `aria-busy`，older revision 或 stale settlement 不能重新锁定控件。
- 插件 manager 同步预留一个应用级 mutation owner，catalog snapshot 暴露 `{ attempt, kind, target, phase }`。
  相同逻辑请求加入现有 Promise，竞争请求立即拒绝且不排队 CLI 副作用；BusyRegistry lease 只属于第一位
  owner。renderer reload 从 catalog 恢复准确文案与完整 mutation-surface lock，只在 active 期间轮询；延迟 poll
  和 dispose 后 timer 都被 fenced。Claude launch registry 另保存 presentation phase：attempt 从 `preflight`
  开始，精确 terminal lifecycle 推进为 `starting`，owned confirmation 进入 `paused`；stale 结果不能倒退
  phase、toast 或恢复入口。
- 关闭、删除等工作区动作仍按 **目标** 去重（`ProjectsState.workspaceMutations`）；新建是刻意的例外：
  `openConversation` 不按目录合并，每次点击都先同步插入独立 pending 行和终端 preview。新建与历史恢复
  共用 renderer `ConversationTransitionQueue`；并发上限由 `navigator.hardwareConcurrency` 推导：1–2 个逻辑
  处理器为 1，3–4 个为 2，5 个以上取一半并限制在 3–8。准入槽内并发运行完整的 main 分配与 CLI 启动，
  溢出任务 FIFO 排队；任务完成（包括回滚退栈）才释放槽，避免只限制 session 分配却同时启动过多 CLI。
  排队状态发布精确 position/total，尾部 `×` 仅能取消尚未准入的 entry，取消后压紧其余位置且不调用
  `openConversation` / `openStoredConversation`，因此没有关闭或归档确认。
- `close:<sessionId>` 与 `close-folder:<规范化路径>` 在确认开始前取得锁并立即重绘，确认取消、IPC
  失败和正常完成都在 `finally` 解锁重绘。会话行显示“正在关闭并归档…”、`aria-busy` 和禁用按钮；
  确认后追加该会话自己的终端遮罩，其他会话仍能操作。全项目关闭与子会话关闭互斥，准备中的项目
  不能整组关闭；全组关闭期间禁止该项目新建和历史恢复。后台推送重建按钮后仍从同一目标锁读取禁用状态，
  不提前删除行，也不把停止失败显示成已归档；失败时保留主进程真实状态供重试。
- 项目列表一次性替换完整子节点并保留外层滚动位置，避免“先清空再逐项添加”把滚动位置夹回零。
  列表高度变化使用三次减速动画推动底部操作区；同一终点的状态刷新保留动画进度，终点变化才从当前
  绘制高度重新定向，不能让频繁后台刷新反复重启动画。
- main 按规范化项目路径单调分配“对话 N”编号；失败或关闭不会复用已消耗的编号，也不因当前行数减少而
  生成重名。后台启动完成只更新自己的 session；需要聚焦时重新读取最新工作区，不使用迟到响应里的活动项。
- main 返回后 pending 行无缝替换为带 `transitioningConversations` 的真实行，CLI 成功才解除“正在新建”。
  失败会关闭精确 session；关闭也失败则写入 `failedConversationTransitions`，左栏显示红色“创建失败 ·
  请关闭”。该失败行的 `×` 直接调用精确临时 session 关闭，不进入“关闭并归档”确认或成功归档文案。
- 历史恢复只做可逆的 UI 移动，JSONL 正文从不重命名或删除。按规范化项目路径和 UUID 记录恢复 overlay，
  从历史呈现中过滤并进入排队/“正在恢复”行，不改写共享历史缓存。取消或失败只撤销自己的 overlay 并
  重新扫描，不能用旧数组覆盖其他恢复和新扫描结果。成功项继续绑定精确 session，直到该 session 关闭，
  避免迟到扫描把已经打开的对话重新显示为历史。模型差异弹窗与 launch preflight 决策各自按到达顺序展示；
  后来的恢复不能因为已有弹窗而被取消。切到兄弟会话不会取消后台决策，只有 owner 消失或 token 过期才
  精确取消。历史扫描使用 `getSessionsForProjectAsync()` 的异步 I/O，并每 256 条 JSONL 记录通过
  `setImmediate` 让出 main 事件循环。

### 退出确认握手

`before-quit` 是同步事件，等不了 promise，而确认框必须是渲染进程画的主题化弹窗（不能用原生
`dialog.showMessageBox`，那又会引入一个不随主题变化的系统控件）。因此退出是一次两步握手：

1. 任何退出入口（托盘菜单、Alt+F4、`Cmd/Ctrl+Q`、安装器重启）最终都到 `before-quit`。若
   `isQuitting` 这个单向闩未置位，就 `preventDefault()` 并转交 `requestQuit()`。
2. `requestQuit()` 只要渲染窗口能应答就始终显示窗口并发 `app:quit-requested`；工作区里 phase 为
   `starting/running` 的会话会被合成为仅用于退出确认的 terminal blocking 项，再与 `BusyRegistry`
   快照一同发送。渲染进程必须通过 `app:confirm-quit` 回答——包括否定回答，否则应用将永远关不掉。
3. 主进程只在收到 `true` 后进入 `beginControlledQuit()`：停止新的权限等待，按登记所有权清理
   派生 Web 子树并复查；无残留才置 `isQuitting = true` 并 `app.quit()`，第二趟进入真正退出。

逃生口都是必需的，缺一个要么丢失回复、要么留下关不掉的进程：窗口不存在/正在加载/已崩溃时
（`canAsk` 为假）仍先执行受控清理；`quitConfirmationPending` 期间再次请求退出或残留对话框中的
“强制退出”才绕过残留阻塞，这是渲染进程卡死或 Windows 检查失败时的出路。普通路径会把精确的
已验证 PID 列表交给界面，允许重试而不是按名称误杀。这里**故意不设确认超时**——pending 通常
意味着弹窗正等着用户读，定时器会在用户面前把应用关掉。`session-end`（Windows 关机/注销，是 `BaseWindow` 事件而非
`app` 事件）直接置闩：系统无论如何都会杀进程，弹窗只是推迟丢失同样的工作。单实例锁失败的
重复启动没有窗口也没有要保护的东西，立即退出。

`BusyRegistry` 是聊天之外的长期操作事实来源：下载登记为 `resumable`，安装、卸载和配置写入登记为
`blocking`，释放函数幂等且所有调用点都在 `finally` 执行。它的快照同时驱动托盘 tooltip、下载
中心与退出确认；渲染进程再把正在流式生成的回复、发送中的提交和附件读取合并进退出清单。确认框
把可后台继续与中断风险分组；新建/恢复的引用计数还投影为 main 中不可取消的
`conversation:workspace-transition` lease，其 `stage` 明确说明历史正文仍在磁盘，但强退会中断尚未提交的
启动或恢复。弹窗以全窗口 backdrop 置灰应用，逐项显示 label、stage 与风险徽标；用户可返回软件、转到
后台继续收尾或二次确认强制退出。没有活动项时仍显示一般退出确认。
工作区终端不注册长期租约，避免把普通 shell 永久标成忙碌，但在退出握手时以精确 session 快照加入
清单。确认框已被其他确认占用时按「取消退出」处理，而不是丢掉这次请求。

最终退出阶段的清理项彼此独立，因此 `runQuitContributions()` 逐项 try/catch 并把失败收集回调用方
记录，而不是让第一个抛错的清理跳过后面所有项——数组最后一项正是强杀 ConPTY `kill()` 覆盖不到的
PowerShell 子树，跳过它会在应用退出后留下常驻 shell。同理，启动失败必须可见：
`app.whenReady().then(onReady)` 必须带 `.catch()`。`runStartupContributions()` 顺序 await，一个抛错的
contribution 会跳过其后全部步骤，而进程级 `unhandledRejection` 处理器又会把它咽掉，结果是一个
既无窗口也无服务、看起来只是"启动比较慢"的进程。现在改为记录日志 + `dialog.showErrorBox` + `app.exit(1)`。

### 后台活动、权限 Hook、流故障与派生进程

- `RuntimeActivityRegistry` 以 `{sessionId, launchGeneration, ptyGeneration}` 作为所有权键，阶段为
  `stopped`、`cli-idle`、`foreground-running`、`waiting-background`、`resuming`、`failed`。
  `Stop.background_tasks` 让顶层回答进入等待后台而不是误报结束；最后一个任务完成后进入
  `resuming`，直到新的顶层 `Stop` / `StopFailure`。任务完成记录最多保留 10 分钟和 20 条，token
  只表达 `likely` / `none` / `unknown`。
- 每次 Claude launch 的临时 settings 注入 `UserPromptSubmit`、`SubagentStart/Stop`、
  `TaskCreated/Completed`、顶层 `Stop`、`StopFailure` 与 `SessionEnd`。PowerShell Hook 只把白名单
  字段写成唯一原子事件文件，不持久化 prompt、回复、工具参数或凭据；轮询消费前后均校验 launch
  与 PTY 代次，旧事件不能唤醒替代会话。
- `ClaudePermissionBridge` 为每次 launch 建立随机 token 的 Windows named pipe，按会话串行处理
  `PermissionRequest`。Hook 最多等待 600 秒，只把工具名与上游建议交给界面；允许/拒绝结果按官方
  Hook JSON 返回。管道、renderer、代次或超时失败都不给出 allow 决策，让 Claude 回到原生交互。
  请求与建议只驻留内存，preload 只暴露类型化 request ID 和 suggestion ID。
- `RuntimeProcessRegistry` 约每 2 秒读取 Windows 进程父子关系和 TCP 监听，只登记当前 PTY 的已验证
  后代且属于常见 Web 可执行程序。`processKey` 绑定目标/根 PID、创建时间与三重会话代次；终止前
  重新捕获和校验，先温和停止、限时后再强制结束精确子树。浏览器、Docker daemon、系统服务以及
  Claude/Codex/CCR 桌面程序永不进入可终止集合。终端明确打印的 URL 标为确认，监听端口推导的
  `http://127.0.0.1:<port>` 标为推断，通配监听额外显示局域网暴露警告。
- 托管 CLIProxyAPI 明确使用 `request-retry: 5`、`max-retry-credentials: 0`、
  `max-retry-interval: 60`、round-robin + 36h session affinity、15 秒 streaming keepalive 和两次
  bootstrap retry。这些设置只覆盖未输出首字节前的安全重试与半开保活；ClaudeDock 不在已经产生
  部分响应后重放请求。缺少 `response.completed`、408/429/5xx、EOF 等只写入时间、分类、版本、
  会话运行时长和任务数，按 14 天、200 条、2 MiB 有界裁剪，并把会话标为 `failed` 供用户在原生
  终端手动继续。

### 全局设置 IPC

- `app:get-settings` 从真实运行时读取 `app.getVersion()`、Windows 登录项状态、
  `WorkspaceStore` 主题和 `AdvancedSettingsStore` 的开关；语言当前固定为唯一已提供的
  `zh-CN`。renderer 不维护版本常量。`app:get-settings`、`app:set-launch-at-login` 和
  `app:set-advanced-settings` 返回同一个 `appSettingsView()`，避免三处各拼一份视图导致漂移。
- `app:set-advanced-settings` 逐个字段校验布尔值、IANA 时区与 BCP-47 语言，不做 truthy 转换，
  也不接受任意环境变量。`AdvancedSettingsStore` 写 `userData/advanced/settings.json`（version 2，临时
  文件加 `renameSync`，权限 `0600`）；version 1 自动迁移，文件损坏、版本不符或字段缺失时回落默认值。
  中转站兼容开关默认关闭；“每次新建会话/登录检测”作为独立安全开关默认开启。运行时在每次创建进程
  前现读，所以改兼容项或 CLI 覆盖不需要重启应用，但不热改已经运行的 PTY。
- 高级设置另有两个只读运行态入口：CCR CLI 管理页与受管 ChatGPT 网关管理页。renderer 每次进入
  该页重新查询主进程；只有对应后台真实运行且管理能力可用时才启用按钮，点击入口本身不启动服务。
  ChatGPT 管理密钥只由主进程写入剪贴板，不通过 preload 返回 renderer。
- `app:set-launch-at-login` 只接受布尔值，调用 Electron `app.setLoginItemSettings()` 后再次
  读取实际状态返回。打包版本使用 `process.execPath`；开发版本额外传入 `app.getAppPath()`，
  避免登录项只启动空 Electron。
- `AppPreferencesStore` 的 `conversationResume` 保存三项偏好：模型不一致时每次询问、始终用当前接入或
  始终恢复对话原接入，以及分别保存的“自动加载上次对话”“启动时自动接入模型”。两个启动开关默认开启；
  store schema 为 version 2，读取 version 1 的 `restoreLastWorkspaceOnStartup` 时把旧值同时迁移到两个
  新开关，避免升级后擅自改变原有选择。设置页和“不再提示”都通过同一严格校验的
  `app:set-conversation-resume-preferences` 原子保存。
- main 启动时从 `WorkspaceStore` 投影中选择最后活动项目，再读取按时间倒序的第一条 Claude 对话；
  自动模型开启时忽略手动历史点击的询问偏好，直接把该 conversation 的完整绑定送入与手动恢复共用的
  `applyConversationModelConnection()`。`testPreparedConnection()` 会先为候选配置保留路由、异步启动其
  所需的托管 ChatGPT 网关或 CCR，再执行真实连接测试；测试通过后才 commit、complete 并调用
  `launchClaudeWithSession()`。候选配置与已保存配置相同也不能跳过此过程，因为静态配置不能证明后台
  服务正在运行。测试与应用成功后把该隔离 profile 提升为全局“下个对话接入”；失败时 profile、Router
  变更和本次新启动的闲置路由服务共同回滚。自动模型关闭时即使 workspace restore effect 关闭也会在
  启动阶段清除全局下个对话 profile，界面明确回到“尚未选择接入”；renderer 同时跳过可见历史恢复，
  保持没有活动模型的普通工作区，但不删除任何项目、历史对话或对话绑定。
- 自动模型开启时，无论“自动加载上次对话”是否同时开启，main bootstrap 都在创建窗口前用短生命周期 PowerShell session
  提供 generation、取消和回滚边界，完成模型验证及全局 profile 提升后关闭该 session。随后可见恢复只
  捕获这份已确认的全局选择，不再依赖 renderer 先打开某个终端。静态 HTML 首帧已将 composer 和发送按钮设为 disabled；可见恢复打开
  stored conversation 后立即用 `beginTerminalMask()` 显示“正在连接模型…”，再在遮罩内完成模型识别，
  不留“先可输入、后上锁”的 hydration 间隙。`ClaudeLaunchAttemptRegistry` 同时禁用 composer、设置
  xterm `disableStdin`、拦截 raw terminal write，遮罩和三层输入门在 settlement 后统一释放。
- 外部代理编辑使用单调递增的加载代次和 `proxyDraftEdited`。首次代理状态回读完成前禁用提交；
  迟到响应只有在代次仍为当前且用户尚未修改草稿时才能回填，避免取消勾选后被旧启用值覆盖。
  “完成”在同一保存路径提交应用设置与代理草稿，再以主进程持久化结果回填 UI。
- 主题继续复用 `ui:set-theme` 与 `WorkspaceStore.terminalTheme`，全局设置和终端工具栏只
  是两个 UI 入口。`src/renderer/platform/components.ts` 的增强选择器控制器同时维护原生 `select.value`、
  trigger 文本与选中态；启动恢复、工具栏切换和设置回填统一调用显式 `sync()`，不依赖伪造
  `change` 事件。全局设置“接入”分类移动的是原高级工具的同一组 DOM 节点，仍使用原草稿
  快照与即时操作边界，没有新增第二套 Router/诊断状态。

### 4.0 共享下载、外部应用代理与 MCP 服务

- `DownloadEngine` 只接受 HTTPS、成对 host/path 白名单、`userData` 内目标、尺寸上限与可选
  精确字节/SHA-256。它基于 Electron `DownloadItem` 计算 EMA 速度、ETA 和真实百分比；未知
  `Content-Length` 以 `-1` 表达。完成后先进入 `verifying`，只有尺寸和哈希均通过才把
  `.partial` 原子改名；失败或取消不会留下可执行的最终路径。连续 45 秒无字节会进入最多 12 次
  指数退避续传，并保留磁盘前缀。
- 续传日志的写入失败在**启动时**是致命的（它是下载目录不可写的探针，由 `download-engine.test.ts`
  钉住），但任务一旦 `settled = true`，取舍就反转：此时抛错会跳过 `releaseBusy()` 与
  `resolve()`/`reject()`，而 `fail()` 又因为已 settled 直接 return，于是调用方的 promise 永远悬着、
  租约在退出确认框里挂到会话结束，且该 id 再也无法重试。`fail()` 一直有这层保护，完成路径与
  取消路径现在也一致——丢一条续传记录可以恢复，卡死一个已完成的下载不行。
- `downloadURL()` 的请求地址与 `DownloadItem.getURL()` 不保证相同：GitHub 重定向后后者可能直接
  返回带短期签名的 `release-assets.githubusercontent.com` 地址。`claimPendingTask()` 会规范化
  `getURL()` 与完整 `getURLChain()`，用链中任一已登记 URL 认领任务，再对每一跳执行原有 host/path
  白名单检查；恢复任务也必须与 journal URL chain 相交，不再让无关下载按队列顺序误领恢复项。
- `src/main/download/github-release-routes.ts` 现在只为受管 GitHub Release 资产建立官方
  `github.com → release-assets.githubusercontent.com` 白名单路径，不再把第三方前缀反代作为
  默认下载安装线路。请求使用 `session.defaultSession`，因此继承 Windows system proxy 或用户
  明确配置的 ClaudeDock 应用代理。
- `DownloadJournal` 每秒把 URL chain、ETag、Last-Modified、长度、已收字节与开始时间原子写入
  `userData/download-journal.json`，启动时用 `createInterruptedDownload()` 恢复。损坏或越界
  记录丢弃，部分文件从不当作完成产物执行。
- `DownloadHistoryStore` 把 completed/failed/cancelled 终态按完成时间倒序原子写入
  `userData/download-history.json`，最多保留 100 条。历史只含任务 ID、显示名称、来源标签、字节数、
  时间和错误摘要，不保存 URL chain、最终路径、代理或凭据；删除历史只移除元数据，绝不删除用户
  已下载的最终文件。损坏文件按空历史处理，不能阻止下载内核启动。
- 4.0.0 删除 `ProxyStore`、节点/订阅解析器、`XraySidecar`、内核源、泄露体检、代理测速、
  外部 TUN 推断和 `WindowsIpv6Service`，同时删除对应 IPC、preload API、renderer 控件、脚本和
  发行测试。旧版 `userData/proxy` 文件不读取、不启用，也不在升级时擅自删除。
- `ApplicationProxyStore`（`src/main/proxy/application-proxy-store.ts`）只持久化一个用户已有
  HTTP/SOCKS5 代理：主机、端口、协议、账号、作用域与 DPAPI 密文密码。主机只接受域名/IP，
  端口限制 1–65535，禁止 URL、换行和明文降级。密码留空保留原密文；账号清空会同时清除密码。
  保存拆成不改内存/磁盘的 `prepare()`、原子持久化后更新内存的 `commit()` 和恢复精确密文及版本的
  `restore()`；安全存储不可用或加密失败时不会留下半保存状态。
- renderer 把 `enabled` 与其余代理字段放入同一设置草稿、脏值计数和“完成”提交事务。关闭时依赖
  区域设置 `inert`/disabled，但不丢弃地址与作用域草稿；重新开启可继续编辑。存储层允许保留未启用
  的 SOCKS5 端点草稿；未启用时若旧草稿仍携带 CLI 作用域，会在保存时清除该无效作用域，只有实际
  启用 SOCKS5 + CLI 组合时才拒绝，避免关闭代理仍无法保存历史配置或出现重启前后状态不一致。
- `application-proxy.ts` 负责三类派生：Electron `ProxyConfig`、CLI 环境和无凭据候选解析。
  应用作用域未启用时为 `system`，独立对话未启用时为 `direct`；启用时为
  `fixed_servers` 且旁路 `127.0.0.1,localhost,[::1]`。CLI 只接受 HTTP，并设置大小写两套
  `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`；SOCKS5 + CLI 在存储层和 UI 都拒绝。
- 代理密码不放入 Electron `proxyRules`。全局 `app.on('login')` 只在
  `authInfo.isProxy` 且 host/port 与事务中的候选或已提交配置完全匹配时 `preventDefault()` 并从
  DPAPI 取账号密码回调，避免向任意 HTTP 认证挑战泄露凭据，也避免会话切换期间错误地只使用旧密码。
  CLI 环境中的凭据使用 URL 编码。
- `ApplicationProxyCoordinator` 使用一条全局 FIFO 事务队列统一 application、conversation 和 CLI
  有效路由。保存按 application → conversation 应用，关闭受影响会话的旧连接，最后提交存储；任一步
  失败都按相反顺序恢复已触碰作用域，无法证明恢复的作用域进入 `unknown`，后续 `reconcile()` 才能
  重新建立 `stable` 状态和随机 epoch。密码变化即使 host/port 不变也会关闭对应 Electron 连接。
- IPC 仅保留 `application-proxy:get/save/test/detect`，保存只调用上述协调器。协调器的作用域状态
  变化由主进程订阅并使官方网络预检失效，因此失败、回滚、非 IPC 保存和 CLI-only 变化都不能绕过
  失效通知。测试使用独立 `claudedock-application-proxy-test` session 对 GitHub 发 HEAD 请求，12 秒超时，
  不调用模型。检测只读取代理环境变量与 `resolveProxy()` 结果，拒绝带凭据、路径、query 或
  fragment 的候选；点选仍需用户保存。
- `McpManager` 从 `~/.claude.json`、当前项目 `.mcp.json` 和 `~/.codex/config.toml`
  发现 MCP，明确不读取 Claude Desktop 配置。在线目录以有界响应读取官方 MCP Registry preview，
  失败时保留离线精选；后台健康任务并发上限为 2。
- `McpRegistryService` 以 cursor 遍历、页数/条目数/字节数上限和 AbortSignal 约束官方 Registry。
  首次或快照损坏时先取完整活动集合，再用 `updated_since=1970-01-01T00:00:00.000Z` 做一次 catch-up，
  合并同名最新 revision 后才原子提交快照；这两阶段避免全量分页期间发生的新增、更新或删除落入缝隙。
  后续增量从已提交的官方 `updatedAt` 水位继续，并请求 deleted 记录保留 tombstone；远端失败、畸形页、
  cursor 循环或持久化失败都保留上一份已验证快照，不用半同步目录覆盖可用目录。
- Claude MCP 安装/卸载只调用 `claude mcp add-json/remove --scope ...` 的 argv；Codex MCP 本版
  只读。项目共享启停先保存目标路径预览和原文件摘要，确认时若摘要变化则拒绝；随后完整备份、
  原子写入并由 `RollbackCoordinator` 在失败时恢复。

### Claude Code 执行设置

- `ClaudeExecutionSettingsStore` 使用独立的 version 1 文件保存“Claude 默认 / 档位 / 自定义”请求，
  不混入项目接入 profile、Claude 用户 settings 或运行中会话。更新、推荐和恢复默认经服务内 FIFO
  串行；存储采用候选校验、临时文件和原子替换，IPC 只返回白名单 DTO，不返回运行期环境副本。
- 五个档位是 ClaudeDock 的显式产品策略，不是 Claude Code 上限，也不代表推理质量。推荐器只用
  `availableParallelism()` 与 `freemem()` 选择 token-saver / restrained / balanced 基线；只有未来注入
  的本机稳定性基准与额度余量同时满足门槛时才允许自动选择 high-throughput / best-performance。
  更高并发可以增加独立工作的吞吐，也会增加 CPU、内存、Token 与限流压力，不能让单次回答更聪明。
- 能力解析先要求可严格解析的 CLI 版本：并发子代理从 2.1.217 起可覆盖且默认 20；派生深度按
  2.1.172–216 固定 5、2.1.217–218 默认 1、2.1.219+ 默认 3 的官方变更矩阵呈现；工具调用并发在
  2.1.217+ 按官方环境变量参考应用，默认 10。未知版本保留请求但不注入，避免把产品输入范围冒充
  Claude Code 支持上限。
- 动态工具搜索对 2.1.221+ 的官方 Anthropic 路由直接应用 `ENABLE_TOOL_SEARCH`；自定义/兼容网关
  必须有当前精确 route ID + model、未过期且不冲突的能力证据，因为不支持 `tool_reference` 的代理
  可能在启用后失败。`inherit` 是“不触碰调用方环境”，恢复 Claude 默认则产生一次显式 delete；
  两者不能折叠成同一个操作。
- 启动解析在第一次 await 前冻结设置快照、路由、模型、进程环境和 settings 环境；最终仅将四个受管
  key 的 `set / omit / delete` 操作物化到未来启动。既有 PTY 与已经准备完成的原生对话不变，避免设置
  对话框在后台篡改活动事务。

### 独立模型对话

- `ChatConfigStore`（`src/main/chat/config-store.ts`）把单一独立 profile 原子写入
  `userData/claude/chat-profile.json`。renderer 只能读取协议、基址、模型、认证方式和
  `credentialConfigured` 与可选服务商 `preset`；密钥用 Electron `safeStorage` 加密，安全存储不可用时拒绝明文
  降级。该文件和项目级 `project-profiles.json` 没有共享键或联动逻辑。
- 基址校验只允许远程 HTTPS，本机 `localhost` / `127.0.0.1` / `::1` 可以使用 HTTP；拒绝
  URL 用户信息、查询和片段。模型名、凭据长度与换行、credential action 均在主进程重验。
- `ChatService`（`src/main/chat/service.ts`）只在 Electron 主进程运行，通过专属 Electron session
  的动态 fetch 适配器发请求，使“对话”作用域可以独立接入/退出用户配置的外部代理。Anthropic
  协议补全 `/v1/messages`、发送 `x-api-key` 和 `anthropic-version`，并解析
  `content_block_delta`；附件块按 document/image → text 排序，本地 UUID 在发请求前才
  base64 编码，Files API 引用自动带 beta header。OpenAI 兼容协议补全
  `/v1/chat/completions`、支持 Bearer，并解析
  `choices[0].delta.content`。OpenAI 流默认请求 `stream_options.include_usage`；遇到拒绝该扩展
  的 400/422 兼容网关会自动重试一次普通流。Responses 协议保留 `/responses` 入口，序列化 stateless
  `input`/`store: false`，解析正文、推理摘要、拒绝与完成事件，保留 incomplete 原因。三种协议都解析供应商 usage 并沿流事件回传；
  中转若返回非 SSE JSON，则提取对应协议的普通文本与 usage。
- 瞬时恢复使用一个跨兼容降级步骤共享的预算：首个有效模型输出前，网络失败以及
  408/409/425/429/500/502/503/504/529 最多自动重试 4 次，采用 500ms 起步、10 秒封顶的
  带抖动指数退避，并接受最长 60 秒的 `Retry-After`。typed `retrying` 事件只回传次数、等待、
  原因和可选状态码，不含请求头、正文或凭据。SSE 必须以 Anthropic `message_stop` 或 OpenAI
  `[DONE]`、Responses `response.completed`/`response.incomplete` 正式结束；首个有效输出前的 EOF、读失败和可重试 provider error 可复用剩余预算，
  已有任何输出后则不重放非幂等请求，以避免重复扣费与重复文本，并把干净的部分回答留在历史。
- 所有消息 POST 使用 `redirect: manual`：301/302/303 因可能改写方法而拒绝，跨源 307/308 因
  可能外带认证头而拒绝，只跟随最多 3 次同源且无 URL 用户信息的 307/308。连接测试复用同一
  重定向边界。
- renderer 先调用 `chat:preflight`，再通过 `chat:start` 发起；两处都在主进程修复失效的
  旧附件并重新校验当前草稿。启动失败会回滚临时消息、保留输入与附件，不把不可发送状态写入
  历史。主进程用 `requestId → AbortController` Map 管理 `chat:stop`，不存在总时长上限。默认
  静默 5 分钟只发 `idle` 事件并用同一运行期配置做一次 15 秒旁路探活，之后约每分钟复查；它
  不会取消仍在思考或没有 SSE ping 的请求。高级设置的本地静默上限默认关闭；显式选用
  5/10/30 分钟时先提示，只在第二个阈值以 `local-timeout` 终止，并明确说明来自本地设置。
  对话 fetch 使用 Undici 的 TCP keepalive，半开连接失败后继续进入既有网络重试阶梯；
  `chat:stream` 的终止原因只有 `manual` / `local-timeout`。中途 EOF 保留部分正文并标记
  `continuable`，renderer 提供“继续生成”发起诚实的上下文续写，而不宣称流级断点续传。
  事件还支持 `retrying/thinking/input-json/refusal/stopReason`，不推送请求头或凭据。
  Anthropic 流请求 `thinking: {type:'adaptive', display:'summarized'}`，若
  400/422 不兼容则丢弃首个响应体并安全重试无 thinking 版本。每次最多 100 条消息、单个文本
  块 200,000 字符、文本合计 1,000,000 字符、响应
  2,000,000 字符；错误文案再次替换可能回显的凭据。
- 手动 `chat:test-connection` 使用当前未保存表单草稿解析运行期配置，发送输出上限 1-token（Responses 16）、15 秒超时、
  64 KiB 响应上限的非流式最小请求；不会顺带保存草稿。结果包含成功状态、净化后的说明、
  延迟和供应商可用时的 usage。协议兼容按 envelope 判定：Anthropic `content` 数组或 OpenAI
  `choices` 数组即为已识别；DeepSeek 思考模型在 1-token 探针中只返回 thinking、没有可见正文时
  仍可通过。真实发送的非流式兼容回退仍要求可见文本，不能因此保存空回复。
- 极简表单通过 `autoDetect: true` 使用 `ChatService.resolveAutomaticConnection`，复用聊天本身的
  conversation fetch 与精确端点授权；只有验证成功后 `chat:save-config` 才原子保存，单独测试只返回结果。
  main 串行保护自动配置，拒绝期间的重复测试与手动保存。renderer 捕获不可变草稿并禁用设置控件，
  关闭弹窗后拒绝旧操作重绘。更换站点、端口或租户路径不得自动复用旧密钥。
- `src/shared/conversation/chat-usage.ts` 是供应商未返回 usage 时的显式回退：ASCII 约 4 字符/token，
  非 ASCII 按 1 字符/token，加上每条消息固定开销。renderer 在输入事件、发送、流式增量及
  终止事件上更新显示；估算数据使用 `source: 'estimated'` 并在 UI 标“约”，供应商数据使用
  `source: 'provider'`。
- `ChatHistoryStore`（`src/main/chat/history-store.ts`）把正文、标题、时间与 Token 快照以
  version 2 明文原子写入 `userData/claude/chat-history.json`：先用 `wx` 和权限 `0600` 独占写入
  同目录的 `.tmp-<pid>-<uuid>`，再重命名。Windows 上仅对 `EACCES` / `EBUSY` / `EPERM` 按
  5/10/20/40/80ms 有界重试；始终只清理本次拥有的临时文件，不先删除目标，因此失败时保留最后一份
  有效历史和原始错误。1.x version 1 字符串消息在读取时规范化成 text block，只有显式 save 才升级磁盘。
  base64 禁止落进历史，未知字段和无效 source 被拒绝。最多保留最近 50 个对话、每个 100 条
  消息；对话 ID 只接受 v4 UUID。只有 `ENOENT` 视为空历史；JSON 损坏、版本未知或权限/
  读取错误会尝试保留 `chat-history.json.corrupt.bak`，随后 fail-closed 抛错，禁止保存覆盖与
  orphan GC。
  每次发送前和生成完成/停止/失败后更新历史；新对话只清空当前视图，逐条删除要经过 renderer
  的应用内危险确认。
- `ChatAttachmentStore` 把白名单普通文件原子复制到
  `userData/claude/chat-attachments/<uuid>/{payload,metadata.json}`，拒绝符号链接、目录、
  空文件、未知扩展和超限输入；`draftId` 的所有变更经主进程 mutation queue 串行，同一消息
  跨批次/并发累计最多 10 个、32 MiB，preflight/start 时还要与当前消息的本地 UUID 集合精确
  匹配。复制、读取与 base64 文件 I/O 使用异步 API；base64 编码和大 JSON 序列化的 CPU 工作
  仍在 Electron 主进程，本版未引入 worker/utility process。图片预览经
  `nativeImage.resize(240×160)` 后才跨 IPC。草稿移除立即删除未被历史引用的副本；删除会话
  和 50 条裁剪会按 retained reference set 回收附件；崩溃残留由带宽限期的
  `collectOrphans()` 维护，且历史不可读时绝不运行。
- renderer 用 `marked.lexer()` 的 token 树自行创建白名单元素，原 HTML 降级为文本；HTTP(S)/
  mailto 外链由 `markdown:open-external` 重验后交给系统浏览器。`https:` 与 `data:` 图片直接
  内联为 `<img>`，带 `referrerpolicy="no-referrer"`、`loading="lazy"`、`decoding="async"`；
  其他协议降级为替代文本。Shiki 只用精细 core bundle 的 9 种语言，代码 token 映射
  到主题 CSS 变量；KaTeX 使用 `trust:false`、`strict:'error'` 和 HTML+MathML。流渲染只从
  已提交稳定边界重新 lexer 尾部并复用稳定 DOM；超过 4 KiB 的长不稳定尾部按
  `max(256, tailLength / 16)` 增长阈值动态降频，奇数个 fence 时把未闭合围栏及其尾部保持
  为不稳定，`finish()` 始终执行一次完整解析。
- 独立对话仍不读取项目文件，也不创建 PTY。历史正文没有使用 `safeStorage` 加密，因为其
  数据体量与可检索性不同于凭据；README 与界面将其明确为本机明文记录。凭据继续只存在
  `chat-profile.json` 的 Windows 安全存储密文中。
- 独立对话左栏只有一个可增长的历史区：`.rail-page--chat` 与 `.chat-history` 依次占满
  `control-panel` 剩余高度，`.chat-history__list` 取消固定 `248px` 上限并独立滚动；空列表时
  `:empty` 取消弹性占位，使说明仍靠近标题。模型配置 DOM 只存在于右上角齿轮模态窗。
- 工作区的 `.project-section` 按剩余高度收缩，项目列表不再限制为 340px；`.workspace-sidebar-footer`
  包含添加项目、快捷操作和托盘说明，按列表自然高度下移，到窗口底部后停止，之后只滚动项目列表。
  列表缩短时操作区重新上移。项目行使用 `grid-auto-rows: max-content`，不得压缩对话行来假装容纳内容。
- 管理页 `.rail-page` 与它们的直接子块显式 `flex-shrink: 0`，由 `control-panel` 承担整页滚动。
  `control-panel` 是定高 flex 列，而 `overflow-y: auto` 的元素自动最小尺寸为 0，因此不加这条
  规则时，接入历史列表会在记录变多时第一个被压扁到几乎不可见，而不是在自己的 360px
  区域里滚动。规则同时排除独立对话和工作区页面，保留它们各自的列表伸缩逻辑。
- 活动栏点击路径在 `toggleRailTab('chat')` 完成主视图和侧栏布局后，通过
  `requestAnimationFrame` 聚焦 `#chat-input`。聚焦前重新核对主视图、`hidden`、输入框禁用、
  composer `inert`、设置模态窗和 Artifact 详情抽屉，避免导航抢走更高层界面的焦点。
- 独立对话与项目终端共用同一套 composer 契约：`.terminal-composer textarea:focus` 与
  `.chat-composer textarea:focus` 是同一条规则，发送按钮与输入框底边齐平并随其高度伸缩，
  聚焦时的一次收敛式 `composerFocusIn` 微光只引用 `--accent-ring`、`--accent-solid`、
  `--accent-tint` 以及主题时长/缓动令牌。两者曾各写一套（对话缺少聚焦动效、按钮不齐平），
  现已合并，避免同类控件在两处发散。全局 `prefers-reduced-motion` 规则仍会把动画压缩到
  `0.01ms`。
- Artifact 详情抽屉的 body 使用 `align-content: start` 和 `grid-auto-rows: max-content`，
  防止少量内容被网格默认 stretch 拉成巨块；正文按说明、网络策略、运行状态、请求审计组成
  紧凑卡片，网络开关仍是可聚焦的原生 checkbox，审计与停止逻辑没有改变。

### Artifact 隔离与联网审计

- `registerArtifactScheme()` 在 `app.whenReady()` 前只注册一次
  `claudedock-artifact`；ready 后 `ArtifactService.install()` 接管 protocol。每段 HTML 上限
  2 MiB、使用随机 `artifact-<uuid>` 内存记录，renderer 只能得到 ID 与自定义 URL。
- iframe 固定 `sandbox="allow-scripts"`，不带 `allow-same-origin`，因此是 opaque origin，
  不能访问宿主 DOM、preload、cookie 或 localStorage。主页面 CSP 只放行该 frame scheme；
  Artifact 响应有独立 CSP，允许可视化常见的 inline/eval，但禁止 object、表单提交和宿主
  导航。d3/Plotly/Mermaid/KaTeX 与 KaTeX 字体走严格 allowlist 的
  `claudedock-artifact://libs/`。
- JSON-RPC 2.0 postMessage 只实现 `claudedock/theme`、`artifact/ready` 与
  `artifact/resize`。宿主先验证 `event.source === iframe.contentWindow`，不使用始终为
  `"null"` 的 sandbox origin 做身份判断；消息最大 64 KiB，高度夹在 240–1200px。
- Electron 普通 sandbox iframe 没有独立 `Session`/partition，项目不把它宣称为独立分区。
  首次加载时把 live Artifact 绑定到 `WebContents.id + WebFrameMain.frameTreeNodeId`；该身份跨
  渲染进程导航保持稳定。`will-frame-navigate` 会拒绝离开原 Artifact host 的跳转并写入
  `NAVIGATE` 拦截日志；`session.defaultSession.webRequest` 也优先按稳定 frame 身份归因和
  断网，URL/referrer 只作为首次绑定兜底。日志最多 500 条，记录时间、方法、完整 URL、状态、
  拦截/错误和响应头可可靠提供时的 `Content-Length`；缺失时保持 `responseBytes` 未定义，
  不伪造实际下载字节数。开关原子持久化到 `artifact-settings.json`：仅文件不存在时默认
  允许，损坏/权限错误会 fail-closed，保存失败不会先改变内存策略。
- renderer 的 `ArtifactController` 只有用户点击 HTML 代码块下方按钮才创建 iframe；维护
  active ID Map，切主题向全部实例推 CSS 变量，停止时先将 frame 导向 blank 并移除，再请求
  主进程清理记录。pending create 使用取消 token；流式重绘移除 mount、`forceCleanup()` 或
  controller dispose 后，即使异步 create 稍后才返回也会立即 destroy 主进程记录。
  MutationObserver 同时清理已断开 DOM 的 active 实例。详情抽屉从
  `getArtifactNetworkState` 取快照，再用 `artifact:network-log` 增量更新。

## 新建项目开发引擎与 Codex

### 下一次新建选择

- `AgentRuntimeStore`（`src/main/runtime/store.ts`）把 `nextRuntime: claude | codex` 原子写入
  `userData/claude/agent-runtimes.json`，文件权限为 `0600`；缺失、损坏或未知值回落到 `claude`。旧版
  `projects` 映射继续读取，供兼容 IPC 与诊断使用，但普通界面不再写它。
- renderer 可在没有活动项目时读取或保存下一次偏好。保存期间先呈现用户选择；IPC 失败会恢复之前值、
  解除 disabled 并显示错误。任一会话正在新建或恢复时 fieldset 暂时禁用，避免用户误以为选择能改变
  已经分配的 session。
- `TerminalWorkspace` 按 session ID 保存实际 runtime。`project:add`、`project:open-conversation` 在创建
  session 的同步提交点读取 nextRuntime，并把 `createdSessionId + runtime` 一起返回；renderer 后续启动
  永远使用这两个精确值，切换前台或稍后改变偏好都不会改写 owner。
- `ClaudeConfigStore` 另以 main-only 应用 scope 保存“下个对话接入”的完整平台、协议、端点、认证、加密
  凭据与主/小型模型。接入页不要求活动项目，通过 `claude:get-next-connection`、
  `claude:test-next-connection`、`claude:save-next-config` 读取、真实测试并原子保存这份选择；失败恢复事务前
  快照；极简新配置失败时保留用户草稿并显示简短错误。
- 极简 `claude:save-next-config` 在同一队列中进行地址归一化、模型发现、最小生成验证和保存。
  Anthropic 直连复用已通过的探针，OpenAI 源还需准备并验证本地 Router，失败回滚。
  自动请求的模型、认证和内置网址由 main 解析，隐藏表单字段不充当验证证据；
  `claude:test-next-connection` 使用同一事务但始终回滚。会话级旧保存通道拒绝自动请求。
  共享候选算法、预算、官方预设与订阅边界见[服务商接入参考](provider-access.md)。
- 每个新 Claude 终端或全新原生对话在创建同步提交点复制一份 conversation profile。后台预检、路由准备、
  PTY/SDK 启动和后续状态读取只使用这份不可变快照；用户随后切换下个模型不会取消或改写已接受的会话。
  关闭精确会话时释放对应 profile。历史恢复先创建隔离 profile，再在真实测试和事务提交成功后应用原绑定。
- `ControlPanelApi` 只暴露结构化 runtime、安装、登录、退出、账号状态和启动方法。preload
  不提供任意命令、任意 App Server method 或任意外链入口；主进程继续验证 sender、session、
  枚举值和登录 URL。

### 官方安装与命令解析

- `CodexInstaller` 只读取 `https://api.github.com/repos/openai/codex/releases/latest`。
  Release tag 必须匹配 `rust-v<semver>`，资产必须叫 `install.ps1`，下载地址必须位于同一
  `github.com/openai/codex/releases/download/<tag>/` 路径，且 GitHub 元数据必须提供
  `sha256:<64 hex>` 和不超过 1 MiB 的正尺寸。脚本下载后再次核对精确字节数与 SHA-256，
  再原子写入 `userData/claude/codex-installers/<version>/install.ps1`。
- 执行固定使用 Windows PowerShell `-NoProfile -NonInteractive -ExecutionPolicy Bypass
-File`，最长 15 分钟、总输出上限 2 MiB，并设置官方脚本支持的
  `CODEX_NON_INTERACTIVE=1`、`CODEX_RELEASE=<version>` 与官方 Release 下载开关。用户输入
  不进入脚本路径、参数或环境变量。
- 运行时优先定位官方独立安装路径
  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`，否则解析 `PATH` 中的 `codex`。
  npm 自动生成的 `codex.ps1` 会在接收 pipe 时通过 `$input` 缓冲到 EOF，无法承载长连接
  JSONL；因此确认同目录存在官方 `node_modules/@openai/codex/bin/codex.js` 后，App Server
  与版本诊断改用解析到的 `node.exe + codex.js`，用户可见 TUI 仍使用原 shim。真实 Windows
  联调已覆盖 npm 安装形态。

### App Server 登录边界

- `CodexAppServerClient` 启动 `codex app-server --listen stdio://`，按行收发 JSONL。连接先
  发送 `initialize`，成功后发送 `initialized`；请求 ID 单调增长，单请求 20 秒超时，单行
  上限 8 MiB，stderr 只保留末尾 4,000 字符并在错误进入 UI 前净化。
- 只调用官方账号方法：`account/read`、`account/rateLimits/read`、
  `account/login/start`、`account/login/cancel` 和 `account/logout`。浏览器方式接受
  `auth.openai.com` / `chatgpt.com` HTTPS URL；设备码方式额外显示 `userCode`。登录完成与
  额度更新通过通知推送，账号缓存失效后重新读取。
- `parseCodexAccountRead` 只映射 `type`、`email`、`planType` 与
  `requiresOpenaiAuth`，其他字段（包括未来可能出现的 token 字段）默认丢弃。OAuth 凭据的
  保存、刷新和退出均由官方 Codex 实现；项目不读写 `~/.codex/auth.json` 或
  `~/.codex/config.toml`。
- App Server 当前仍标记为 experimental，因此首版只依赖稳定、可回退的账号状态面，不把
  完整任务执行绑死在协议上。账号读取失败会形成 warning；已安装 CLI 仍可在终端中按官方
  行为人工登录和使用。

### Codex 会话启动

- `CodexRuntime.prepareLaunch()` 构造 PowerShell 单引号转义命令，固定包含
  `--cd <cwd> --sandbox workspace-write --ask-for-approval on-request --no-alt-screen`。
  新建直接运行 `codex`，继续最近使用 `codex resume --last`，选择历史使用 `codex resume`。
  不提供 `danger-full-access` 或 `never` 审批快捷入口。
- 启动前要求官方 CLI 已安装；当 `requiresOpenaiAuth` 为真时还要求存在账号。主进程重启当前
  PTY 后再写入命令，使用 OSC 退出标记跨 chunk 跟踪 TUI 结束并从 renderer 输出中移除标记。
  终端停止、重启、关闭项目与应用退出都会把两类 runtime 状态一起释放。
- 浏览器登录的一键路径把待启动 session 记在 renderer 内存中；`account/login/completed`
  到达且账号刷新成功后自动启动。并发操作锁避免登录通知早于 IPC 返回时重复/漏启，失败则
  保留项目和登录状态供用户重试。

### 与 CC Switch 类能力的边界

- 调研的 `farion1231/cc-switch` 已覆盖多工具 Provider、MCP、Skills、提示词、用量和本地
  代理；这证明 ClaudeDock 后续应把“受管应用 / 安装适配器 / 扩展同步”建成能力层，而不是
  继续把所有功能堆进 Claude 路由表。
- 其 Codex OAuth → Claude 路径本质是本地反向代理与 Anthropic/OpenAI 协议转换，不会让
  Claude Code 原生获得 ChatGPT 订阅。CC Switch 自身文档也明确标记服务条款、账号与长期
  可用性风险。2026-07-12 的公开帖子中，OpenAI Codex 负责人 Tibo 分享了 Theo 的三步
  CLIProxyAPI/`claudex` 方案，构成明确的公开实践认可；但 OpenAI 当前帮助页列出的 Codex 客户端
  仍不包含 Claude Code，CLIProxyAPI 也不是 OpenAI 或 Anthropic 产品。4.3.0 在用户显式点击后
  托管这个独立进程的安装与生命周期，不把它伪装成官方集成；官方 Codex 客户端通道继续独立存在，
  CC Switch 也不是这条受管流程的依赖或中间操作界面。

### ChatGPT 订阅受管网关

- 并发启动共享一个 `ensureRunning()`；安装、启动、换号等生命周期事务进行中，公开状态读取只报告
  busy，不另行探测或提升尚未提交的进程。相同授权事务的文件检查与相同 PID/出生时间/路径/端口的
  Windows 进程检查只合并正在执行的工作，不缓存完成后的所有权结论。授权目录与其精确子文件在一个
  PowerShell 调用内逐项设置并验证 ACL。检查超时或权限不可读只表示无法确认，保留精确出生身份记录，
  不授权访问，也不把存活网关误删为“已退出”；只有 absent/mismatch 才清除对应旧记录。
  模型传输在连接、异步所有权检查和响应复核全程持有 socket error listener，断开后不发送 Bearer。
- `ManagedChatGptGateway`（`src/main/claude/managed-chatgpt-gateway.ts`）只从
  `router-for-me/CLIProxyAPI` 的 GitHub `releases/latest` 查询发行元数据。版本必须是严格 SemVer，
  资产名必须精确匹配 `CLIProxyAPI_<version>_windows_amd64.zip`，下载地址必须位于预期仓库/tag，
  size 必须小于 128 MiB，digest 必须是 GitHub 提供的 SHA-256。`DownloadEngine` 再验证最终字节数
  与摘要；元数据响应限制为 2 MiB 并拒绝重定向。
- 安装根目录固定为 `userData/managed-gateways/cliproxyapi/`；版本文件进入 `versions/<version>/`，
  OAuth 文件进入专用 `auth/`，下载缓存进入 `downloads/`。解压前最多接受 500 个归档条目并拒绝
  绝对路径、盘符和 `..` 路径；暂存目录只有通过可执行文件位置检查后才原子改名。递归清理函数只
  接受 `versions/` 的直接子目录，不能扩大到 `userData` 或项目目录。解压后记录可执行文件自己的
  SHA-256，状态检查与每次启动前重新计算；本地文件被替换时拒绝运行并要求重新安装。
- 首次配置在 `8317–8327` 中选择空闲端口，强制 `host: 127.0.0.1`、关闭 TLS（仅限本机回环）、
  远程管理、文件日志、用量统计和面板自更新。管理页只允许本机访问并要求独立随机
  `mgmt-claudedock-*` 密钥；随机客户端/管理密钥以 DPAPI 密文写入 `state.json`，项目配置副本也由
  `ClaudeConfigStore` 加密。CLIProxyAPI 运行时必须读取的 `config.yaml` 含本机明文副本，因此该文件
  用权限 `0600` 写入且不进入仓库、日志或 IPC 状态。只有高级入口被点击时主进程才把管理密钥写入
  剪贴板并打开 `/management.html`，密钥不返回 renderer。
- “一键安装并登录”IPC 只返回净化后的状态，普通接入不传 `sessionId`。没有项目也会连续完成应用级
  Claude Code 检测/安装、网关安装、OpenAI 授权、启动、模型发现、真实连接测试与全局下个对话 profile
  保存，共 8 个可观察步骤；任一步失败都返回明确结果并保留原选择，不会停在第 6 步形成伪成功。
  全局安装和模型切换的外层 Provider 守卫使用 `nextConversationConnectionScope()` 返回的 main-only profile
  身份及 application 网络作用域；内部首次请求复用同一精确身份，因此嵌套预检不会把全局事务误判为跨项目，
  同时仍拒绝真正的跨 Provider、跨项目、跨网络作用域或跨 target 复用。
  操作先检查 Claude Code；缺失时调用项目已有的官方
  安装路径补齐，再以隐藏窗口运行
  `cli-proxy-api.exe -config <owned-config> -codex-login`，由上游进程打开 OpenAI 官方授权页；
  ClaudeDock 不接收密码或 Cookie；主进程只在本机解析专用目录里的 OAuth JSON，以验证文件稳定性、
  严格结构、非空令牌字段和脱敏账号邮箱，不保存、使用、记录或通过 IPC 暴露令牌值。授权前在
  `1455–1465` 中自动选择空闲回调端口并通过上游官方参数传入；授权最长等待 10 分钟，错误文本会移除
  Bearer、本地回调地址和疑似密钥。成功保存协议只
  从 stdout 解析，stderr 保留为诊断流；上游在成功流程输出的浏览器或回调关闭 warning 不会被拼到
  最终成功标记之后而误判失败，非零退出仍由子进程边界拒绝。
- 首次授权与换号使用 `ManagedGatewayAuthenticationTransaction`：旧授权先进入随机 `quarantine` 目录，
  新文件在网关和模型目录真正就绪前保持待提交。公开状态、普通启动和恢复路径看到任何待提交事务都
  必须失败关闭；只有当前 `setup()` 尝试可携带它精确拥有、尚未 finalized 且唯一处于 `active` 的事务，
  完成启动前后两次文件校验。存在第二个事务、错误目录、异常 phase 或无效文件时仍拒绝；就绪后提交
  才删除旧授权，任一步失败则先停止新网关再恢复旧授权。
- “退出当前账号”使用单独的无参数 IPC，不复用上述登录命令：先验证并停止 ClaudeDock 精确拥有的
  本地网关进程，再只清除 `auth/` 内受管授权文件和 `state.json` 中的授权/进程记录。该操作不经过
  Provider 预检、不要求项目或模型、不调用浏览器 API，也不读取或删除浏览器 Cookie、Google 登录或
  Codex/Claude Code 用户目录。退出成功后界面进入等待授权状态；新的浏览器授权必须由用户再次点击主按钮。
- 兼容的会话内托管切换若收到 `sessionId` 且 `ClaudeRuntime.isActive(sessionId)` 为真，主进程先 `workspace.stop()` 并把
  runtime 标为 inactive；这是计费安全边界，不允许旧 PTY 在最长 10 分钟的授权窗口里继续使用启动
  时的中转环境。真实测试与保存成功后，主进程以 `prepareLaunch(..., 'continue')` 重新生成临时
  settings 和环境、重启 PTY 并恢复最近会话；准备、spawn 或写入失败都会再次停止 PTY，绝不回落到
  旧路由。模型下拉切换对活动会话复用同一恢复路径。其他项目 session 不在该事务范围内。
- `buildManagedGatewayEnvironment()` 是 CLIProxyAPI 安装、OAuth 登录和常驻 sidecar 的统一进程净室：
  按大小写不敏感规则删除 `OPENAI_*`、`CODEX_*`、`ANTHROPIC_*`、`CLAUDE_AGENT_*`、
  `CLAUDE_CODE_*`、`CCR_*`、`CODEXL_*` 与 `ELECTRON_RUN_AS_NODE`，防止父进程的旧基址或密钥
  改变上游；`HTTP_PROXY`、
  `HTTPS_PROXY` 和 `NO_PROXY` 继续保留，因为它们只描述到官方端点的传输路径。
- `setupInFlight` 是整个安装、校验、授权、启动周期的单例 Promise；重复 IPC 直接等待同一 Promise，
  不会再次获取 BusyRegistry 租约或启动第二个下载。公开状态在此期间返回 `busy: true` 与
  `phase: installing`；renderer 另用可区分全局/项目范围的本地 operation tracker 覆盖 IPC 往返窗口，
  所有 progress 都先记账再按当前向导渲染，因此项目切换不会漏掉完成事件或永久锁死按钮。
- 授权后主进程隐藏启动 sidecar，持久化 PID、出生时间、可执行文件、精确配置路径与回环端口身份。
  模型读取先建立空 TCP 连接，通过 Windows 进程表和 established tuple 证明该连接的服务端确属这一
  精确进程，之后才在同一 socket 写入随机本地 Bearer；响应完成后再次核对进程出生身份，再接受
  `GET /v1/models` 的结果。模型读取的两次 PowerShell 身份检查各有 3 秒执行预算；冷启动出生身份捕获、
  readiness 后最终所有权确认及普通所有权复核使用 5 秒默认预算，避免 PowerShell/CIM 冷启动接近 2 秒时
  误报身份失效。超时后的安全进程清理与其余
  网络步骤共同受一次 readiness 8 秒总预算、以及 20 秒启动总 deadline 约束，避免把正常的
  HTTP 200 因共同 1.5 秒预算耗尽而误判为空模型。最终失败会优先显示经过密钥、账号和路径脱敏的
  最近一次完整预算模型检查类别；没有完整预算结果时才回退到最近一次，清理也失败时会组合脱敏后的两类错误。
  `provider-model-discovery.ts` 从根地址、`/v1`、Chat Completions 或 Responses 地址推导模型端点，
  拒绝跨站重定向，把响应限制为 1 MiB / 500 个安全模型标识。实时目录同时验证端点、Bearer 密钥和
  账号可见模型；主进程据此推荐聊天/小型模型，再执行最多 1 token 的真实请求。网络或超时失败会
  自动重启 sidecar 并复检一次，仍失败则不改原项目配置。renderer 只显示实时模型选择框；切换模型
  会重新获取目录、实测并事务性保存，不暴露地址、认证或凭据输入。
  `ClaudeRuntime.prepareLaunch()` 在受管预设启动前调用 `ensureRunning()`，应用
  完全退出或活动 CLI 路由不再需要它时终止 sidecar；进程重启后若 PID 仍在，先用 WMI/CIM 核对
  `ExecutablePath` 与私有版本目录完全一致才终止，拒绝按名称批量杀进程。不会修改 shell profile、
  Claude Code 用户设置、Codex 凭据或 Windows 系统级代理/API 路由。
- `setup()` 每次都会尝试查询最新上游 Release；版本未变则复用已验证安装，版本变化则下载新版本并
  保留认证目录、随机本地密钥和端口。GitHub 暂时不可达但本机副本完整时允许离线启动已有版本；首次
  安装或本机哈希异常时仍失败关闭。外部检测到的 CLIProxyAPI 继续按高级通用 Gateway 呈现，不读取、
  迁移或接管其配置与 OAuth 文件，避免两套所有权边界混合。

## Claude Code 接入与会话

### 项目级路由

- ClaudeDock 以规范化绝对项目路径作为配置键；非敏感配置和加密凭据保存在 Electron
  `userData/claude/project-profiles.json`，不写入仓库中的 `.claude/settings*.json`。
- `ClaudeConnectionHistoryStore`（`src/main/claude/connection-history.ts`）在
  `userData/claude/connection-history.json` 按项目保存最近 20 条接入配置，写入同样是
  临时文件加 `renameSync`、权限 `0600`；文件损坏时 `load()` 回落到空存储而不是抛错。
  项目键用小写后的绝对路径，因为 Windows 路径大小写不敏感。
  Anthropic 直连凭据以 `safeStorage.encryptString(...)` 的 base64 存放；`decrypt` 在安全存储不可用时返回
  `undefined` 而不是抛错，所以恢复出来的记录顶多是“没有凭据”，不会变成明文。
- 历史文件为 version 3，每条保存可选 `name`、必填 `protocol`（`anthropic | openai |
unknown`），并可保存 OpenAI 原始上游的地址、认证、主/小型（备用）模型、凭据状态与 Router Provider
  ID。version 1/2 读取时，已知直连预设迁移为 Anthropic；旧 `gateway` 记录无法从本机 Router
  地址反推出上游协议，因此迁移为 `unknown`，下一次写操作会以 version 3 原子落盘。
- `ConversationPreferencesStore` 的 version 2 为每个 conversation UUID 保存完整连接绑定：接入预设、
  协议、端点、认证方式、Router Provider、主/小型模型、接入名称、订阅账户/认证描述、凭据状态与
  SHA-256 指纹。需要恢复的原始 API 凭据只以 `safeStorage` 密文写盘，renderer 仅接收十位指纹前缀和
  脱敏地址；旧 version 1 只有模型名的记录仅在匹配到唯一完整接入身份时做尽力推断。同名模型对应多个
  账户、凭据、端点或路由时拒绝猜测，并明确标为只知道模型名。
- OpenAI 转换接入还把当前 Router Provider 的上游凭据单独以 `sourceEncryptedCredential` 写入项目 profile；
  它与本机 Router 客户端凭据分开加密，只在 Provider ID 相同且选择保留凭据时沿用，切离 OpenAI 路由或
  改用另一 Provider 就清除。这样即使接入历史的非关键写入失败，后续启动快照仍能绑定实际当前 API，
  不会误拿一条旧历史记录的密钥。
- 终端与原生对话都从准备启动时冻结的同一 `ClaudeLaunchConfigSnapshot` 生成绑定并写入对话偏好，不能在
  await 后重新读取易变项目配置。完整比较包含平台、协议、端点、认证、订阅账户、API 指纹、Router
  Provider、主模型和小型模型；小型模型空白先规范化成主模型，因此“上下都填同一模型”和“下方留空”
  相等，而任何真正不同的字段——即使同一中转站、同一 API 或同名主模型——都会触发差异。
- `claude:conversation-model-inspect` 只返回两套脱敏身份、差异项、可恢复性和用户偏好。选择“使用当前
  模型”只把该对话重新绑定到当前完整接入；选择“使用该对话原有模型”复用 provider access guard、
  `runClaudeProjectConfigTransaction` 与真实模型请求，测试通过才提交，失败按既有项目/Router 所有权
  规则回滚。订阅账户已变化且不能安全重建时禁用原接入按钮，不做隐式登录切换。
- `claude:connection-history-apply` 不再把“配置事务提交”当成连接成功。handler 先通过
  `prepareConnectionHistory()` 解密并准备候选，再由 `testPreparedConnection()` 对这份尚未提交的
  effective input 发出最多 15 秒、`max_tokens: 1` 的真实 Messages 请求；只有端点、认证与 Anthropic
  消息 envelope 全部通过才进入 `runClaudeProjectConfigTransaction` 的 commit。测试失败保持原配置，
  并把结构化 `connectionTest` 连同失败结果返回 renderer。`authMode: existing` 的 Claude 官方登录不读取
  Claude Code 令牌，因此独立 Messages 探针允许 warning；该边界只说明探针不能借用 CLI 凭据，不代表
  Claude 账号状态不可获取。
- `official-auth-status.ts` 由主进程执行 `claude auth status --json`，调用前清除 Anthropic key/token/base URL
  与 Bedrock、Foundry、Vertex Provider 覆盖，使用 8 秒超时、64 KiB 输出上限和 30 秒异步缓存。解析器只
  接受布尔 `loggedIn`，并只投影长度与控制字符校验后的账号邮箱、`authMethod`、`checkedAt`；原始输出、
  token、组织 ID 和未知字段全部丢弃。CLI 在未登录时会携带合法 JSON 以退出码 1 结束，因此仍从命令封装
  的有界 stdout 解析为明确“未登录”；命令缺失、超时、无合法状态载荷或格式异常才降级为
  `{ available: false, loggedIn: false }`。该投影作为既有 `ClaudeProjectState.officialAuth` 随
  `claude:state` 返回和广播，不增加 IPC 频道或 `ControlPanelApi` 成员。
- OpenAI 候选准备会先改写本机 Router Provider，因此 prepared value 同时携带该次写入的精确补偿。
  `runOwnedConfigTransaction` 把真实连接测试作为 pre-commit `validatePrepared` 阶段；取消、测试失败或之后
  任一事务失败都会调用 `rollbackPrepared`。补偿只在 CCR service 的 origin、PID、service token 仍相同，
  且 `getConfig` 仍等于 `saveConfig` 返回的服务端规范化结果时恢复旧 Provider、preferred 与 credential；
  任何较新的 Router 保存都优先保留，不会被失败事务覆盖。prepare 在保存后的自身失败也执行同一补偿。
- 项目配置事务在 prepare 前保存完整配置快照，并在 commit 后记录本事务实际留下的快照。失败或取消时只在
  generation owner 仍有效、发起 session 仍映射到同一规范化项目目录、当前快照仍等于本事务保存结果时恢复
  原项目配置；否则报告恢复边界并保留较新写入。恢复后的权威 `ClaudeProjectState` 会重新发布，Router 的
  `rollbackPrepared` 则补偿项目文件之外的外部状态。
- 历史应用在 `SessionOperationCoordinator` 中持有唯一 `AbortSignal`。新增
  `claude:connection-history-cancel-apply` 只调用 `invalidateAndWaitIfSignal(sessionId, signal)`：signal 与当前
  lease 不完全相同就返回 `false`，不能误取消同一项目稍后启动的其他终端任务。连接 fetch 使用
  `AbortSignal.any([ownerSignal, AbortSignal.timeout(15_000)])`；用户取消原样抛出 owner reason，等待事务
  rollback/unwind 完成后才向 renderer 返回已取消。
- renderer 的 `history-dialog.ts` 只管理分类、当前选择与确认；`history-recovery.ts` 以 attempt fence 管理
  `running / cancelling / failure / success`，运行时隐藏并 inert 普通向导，失败允许用同一 entry ID 重试，
  成功 1.5 秒后恢复原 surface 快照。历史 load/apply/delete/rename token 均携带 `{ generation, sessionId }`；
  项目切换递增 generation、失效 mutation/recovery owner、清空旧历史和专用 surface，因此迟到 settlement
  既不能重绘新项目，也不能释放新 owner 的 busy。`current-connection-summary.ts` 是不接触 DOM 的脱敏纯函数，
  同步消费 Claude `officialAuth`，`current-connection-view.ts` 把当前配置与历史名称匹配，并用相同
  generation + active session fence 异步补充 ChatGPT 账号。
- 判重用 `apiKeyHelperPolicy`、认证方式、地址、凭据、主/小型（备用）模型、预设、provider 和上游协议的
  SHA-256 指纹，与**全部**记录比较而不只是最新一条：命中就把那条记录移到最前面并刷新
  `savedAt`，`id` 与名称保持不变，因此恢复一条较早的记录不会变成一条重复记录，指向它的重命名
  或待处理引用也不会失效。空白的小型/备用模型在写入时就归一为主模型，自动补全不能让同一份配置
  读起来像变了。指纹**刻意不含 `gatewayState`**——它描述的是保存那一刻
  机器的状态而不是用户填的配置，网关在 running/stopped 之间反复跳会把同一份配置刷成一堵墙。
  网关状态仍然逐条存下来，恢复时能看到当时的情况。
- `saveConfig` 成功后才记历史，且整个记录过程包在 try/catch 里：配置已经保存了，
  少一条历史不值得让保存失败。`applyConnectionHistory` 对 OpenAI 记录重新走协议转换准备，
  其余记录走同一个 `saveConfig`，
  所以恢复和手工保存的路径完全一致；回放对象同时携带名称和协议，不能在恢复后退化为默认
  Anthropic。保存/修复 Router Provider 并用于当前项目时，`anthropic_messages` 映射为
  `anthropic`，`openai_chat_completions` 与 `openai_responses` 都映射为 `openai`，Provider 名
  作为历史默认名称。历史条目 ID 由主进程用
  `/^history-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/` 校验后才接受。
- `claude:connection-history-rename` 只接受字符串名称；存储层统一裁剪首尾空白并限制为 1–60 个
  非控制字符。它只更新目标记录的 `name`，不改协议、地址、模型或凭据。renderer 通过 preload
  暴露的窄接口调用，主进程返回刷新后的项目历史列表。
- renderer 将历史作为接入主流程组件固定在服务商选择与模型表单之间，不把它移动进全局设置
  `<dialog>`。每条恢复按钮显式渲染名称、协议/连接方式标签、`baseUrl`（接口/网关）、
  `gatewayEndpoint`（与基址不同时）、`model`、`modelFast`、认证方式、`apiKeyHelperPolicy`、
  凭据布尔值和保存时网关状态；右键菜单提供重命名/恢复/删除。列表在 360px 高度内独立滚动，
  长地址和模型名允许断行。
- Anthropic 官方接入支持 Claude Code 现有登录或 `ANTHROPIC_API_KEY`。兼容网关设置
  `ANTHROPIC_BASE_URL`，并支持 `X-Api-Key`、Bearer Token 或本机无认证三种模式。
- `chatgpt-subscription` 预设仍属于 `gateway`，但它的地址、认证方式和客户端密钥只由
  `ManagedChatGptGateway` 生成：`ANTHROPIC_BASE_URL` 指向实际分配的 `127.0.0.1:8317–8327`，
  主/小型（备用）模型从实时 `/v1/models` 目录中选择，优先匹配可用的 GPT 聊天与 mini/nano 类模型；随机
  `api-keys` 值以
  `ANTHROPIC_AUTH_TOKEN`/Bearer 注入当前项目子进程，而不是被误当成 ChatGPT OAuth Token。
  `normalizeClaudeConfig` 继续把该预设限定在 `localhost/127.0.0.1/::1`，避免把 OAuth 转换路径
  扩展为远程订阅转售服务。模型名仅为可编辑默认值，真实可用性由上游网关与账号决定。
- 接入配置分别保存 `model` 与 `modelFast`。主模型写入 `ANTHROPIC_MODEL`、
  `ANTHROPIC_CUSTOM_MODEL_OPTION`、Opus 与 Sonnet 别名；小型/备用模型写入
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL`。旧配置缺少该字段时
  自动回落到主模型；启动时同时使用 `--model` 提高可观察性。
- 带 `/v1/chat/completions` 的服务是 OpenAI Chat Completions 格式，不能直接满足
  Claude Code 的 Anthropic `/v1/messages`、流式内容块和工具调用语义，必须经
  Claude Code Router、LiteLLM 或服务商自己的协议转换层。
- 自定义表单选择 OpenAI 时，`ClaudeRuntime.prepareOpenAiConnection` 规范化上游端点，以保存的
  Provider ID 或规范化端点复用 CCR Provider，写入模型和上游密钥并启动 3456 网关；项目运行
  配置只保存 Router 客户端密钥和 `Provider/Model` 路由。`ClaudeConfigStore` 另存不含秘密的
  presentation 字段，使 renderer 重开后仍显示原始上游而不是内部 3456 路由。
- DeepSeek 官方目前另行提供 Anthropic 格式，基址为
  `https://api.deepseek.com/anthropic`；因此 DeepSeek 官方预设可以直连。官方兼容表仍列出
  图片、文档、部分 MCP/代码执行结果等不支持
  或忽略字段，界面不会把“Anthropic 格式兼容”描述成完整 Claude 功能等价。
- 远程中转只接受 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1` 或 `::1`，URL 不允许嵌入
  用户名、密码、查询参数或片段。

### 模型服务速度

- `modelFast` 继续表示接入配置中的“小型/备用模型”，会改变模型身份；服务速度是独立的
  `ModelSpeedMode = standard | fast`，不能复用或迁移该字段。`model-speed-capabilities.ts` 是唯一
  能力判定入口，renderer 只消费结构化 availability/mechanism/status，不按模型名自行猜测。
- 官方 Anthropic 接入只有 Claude Code `>= 2.1.219` 且实际/目标模型明确属于 Opus 5 或
  Opus 4.8 时开放 `claude-native-fast`。Fast profile 在会话专用 settings 写
  `fastMode: true`、`fastModePerSessionOptIn: false`；标准 profile 写 `fastMode: false`、
  `fastModePerSessionOptIn: true`。ClaudeDock 不设置 `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK`；只有
  statusLine 的 `fast_mode` 严格布尔值为 `true` 才报告 active，资格或额度拒绝时报告 not-active。
- 受管 ChatGPT 只有已安装 CLIProxyAPI `>= 7.2.117` 且模型为 `gpt-5.4`、`gpt-5.5`、
  `gpt-5.6`、`gpt-5.6-sol`、`gpt-5.6-terra` 或 `gpt-5.6-luna` 时开放
  `gpt-service-tier`；`gpt-5.4-mini` 和未知未来模型保持 unverified。Fast profile 在 PTY 环境与
  settings `env` 注入精确的 `CLAUDE_CODE_EXTRA_BODY={"service_tier":"fast"}`。该路径只能报告
  requested，不能从 Claude statusLine 推断 OpenAI 上游已经采用 priority tier。
- 标准 profile 总是显式清除继承的 `CLAUDE_CODE_EXTRA_BODY`，防止上一会话的服务档位串到新模型。
  Claude 原生 Fast 不设置 service tier；GPT Fast 关闭 Claude 原生 `fastMode`。模型切换只有端点和
  speed signature 都一致时才允许运行中 `/model`，否则必须重建 PTY。
- `ModelSpeedPreferencesStore` 把偏好原子写入
  `userData/claude/model-speed-preferences.json`，权限 `0600`、损坏时回落为空、最多保留 400 条。
  target key 由 runtime、provider、preset、认证方式、去凭据端点身份和规范化模型生成 SHA-256；
  官方与受管回环分别使用稳定身份 `anthropic://official`、`managed-chatgpt://local`。文件只含哈希、
  mode 和时间戳，不保存 API Key、OAuth Token、Bearer Token 或它们的哈希。
- 活动会话切换速度要求 statusLine 已给出真实 conversation UUID，随后用精确
  `--resume <uuid>` 重启同一对话，不执行 `/compact`。PowerShell restart/write 成功后才提交偏好；
  失败保留原偏好并把 runtime 对账为 inactive。未活动时只保存下次启动使用的偏好。
- 原生 Codex runtime 不进入这套存储和 IPC，renderer 明确显示“速度 Codex 内管理”。

### 安全启动

1. 主进程用固定 PowerShell 诊断命令解析 `claude --version`。命中 Claude Code 官方安全公告的
   版本直接阻止，其他低于 2.1.197 的版本要求升级；当前验证环境为 2.1.221。
2. `ClaudeRuntime` 为项目会话生成 `userData/claude/runtime/<session-id>/settings.json`，
   通过 Claude Code 官方 `--settings` 参数临时合并，不改变用户、项目或系统设置。命令行
   settings 优先于用户设置，因此会同时写入无秘密的 `env` 覆盖：固定当前项目的标准基址
   与模型，并把 `ANTHROPIC_API_BASE_URL`、`CLAUDE_AGENT_API_BASE_URL`、
   `CCR_CLAUDE_CODE_MODEL`、`CODEXL_CLAUDE_CODE_MODEL`、Router 模型发现开关以及
   `CLAUDE_CODE_DISABLE_THINKING`、`CLAUDE_CODE_EFFORT_LEVEL`、`MAX_THINKING_TOKENS`
   清空，防止旧 CCR profile 把真实会话重新指向已停止的 `3456`，也防止父进程环境覆盖底栏
   的 thinking / effort 选择。项目级 `apiKeyHelperPolicy` 默认为
   `prefer-claudedock`：仅当认证方式是显式 API Key / Auth Token 时，在该临时高优先级 settings
   写入空 `apiKeyHelper`，让本次 ClaudeDock 会话只使用安全存储中解密后注入的凭据；`inherit`
   则不写覆盖，保留 Claude Code 自己的 helper。现有登录和无认证模式不会停用 helper。
   同一份 settings 里注册三个本地能力：statusLine 指标采集、`PostCompact`/顶层 `Stop`
   完成信号，以及 WebSearch/WebFetch 主线程路由守卫；它们只读 hook stdin、写会话目录 JSON
   或返回本地 hook 决策，不外发。
3. 主进程重建当前 PowerShell，并在 PTY 创建时注入路由与解密后的凭据；密钥不会出现在
   命令行、临时 settings、xterm.js 输入或 PowerShell 历史中。完整启动脚本通过
   `CLAUDEDOCK_STARTUP_COMMAND` 一次性交给 PowerShell 启动段，启动段在提示符出现前把值捕获到
   进程变量并删除环境副本；主进程完成 PTY generation 绑定后只写入固定的
   `Invoke-ClaudeDockStartup`，因此内部 settings 路径、环境清理列表和 marker 不再铺满可见输入。
   默认命令只保留 `--settings` 与必要的权限/恢复参数，不再重复传 `--model`，也不传
   `--no-chrome`；模型由同一临时 settings 与项目环境确定，Claude in Chrome 是否使用则回归
   Claude Code 原生能力。认证策略属于端点指纹的一部分，修改后必须重启 PTY，不能把旧会话当作
   同一端点热切模型；Claude 退出后命令会清理所有受管环境变量与第三方路由别名。
4. 标准和网关 profile 关闭遥测：`DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`、
   `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`、`DO_NOT_TRACK=1`。网关模式还关闭自动更新，因为
   ClaudeDock 自己管理 Claude Code 版本。`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 与
   `DISABLE_FEEDBACK_COMMAND` 显式清空，保留 `/bug`、`/feedback` 和官方组织资格检查；不加入
   任何资格绕过变量。
5. 临时 settings 设置 `skipWebFetchPreflight: true`，避免 WebFetch 在第三方模型接入时把域名
   发往 `api.anthropic.com`。WebFetch 仍受 Claude Code 自身的权限提示约束。
6. 启动命令按项目的 `allowBypassPermissions` 追加
   `--allow-dangerously-skip-permissions`（把 `bypassPermissions` 加进 `Shift+Tab` 循环，
   但不以该模式启动），需要以特定模式启动时另加 `--permission-mode <mode>`。两者不叠加：
   直接以 `bypassPermissions` 启动时不再附加 `--allow-` 变体。这个开关的默认值是开启，
   但「预置」和「激活」是两件事——ClaudeDock 不会替用户进入完全允许模式。

`safeStorage` 在 Windows 使用操作系统凭据保护能力；若不可用，保存密钥会失败关闭，而不是
回退到明文。渲染进程只能获得 `credentialConfigured` 布尔值，从不获得已保存密钥。

### 自动发现与新手接入

- `src/shared/claude/providers.ts` 是接入目录的单一事实来源：22 个预设统一声明分组、基址、
  认证方式、主/小型（备用）模型、控制台、文档、密钥提示和风险说明。`ClaudePreset` 直接派生自目录
  ID；主进程 IPC 用目录 ID 集合校验，外链白名单从目录 URL 主机派生，避免 renderer、主进程
  与文档手写三份漂移。原有 `anthropic / deepseek / gateway / custom` ID 保持兼容。
- `normalizeClaudeConfig` 用目录分组推导 `provider`：官方组进入 `anthropic`，其余进入
  `gateway`；未知的旧预设按可验证配置迁移到 `custom`，无效基址或模型则安全回到默认配置。
- `src/shared/router/connection-endpoint.ts` 是自定义连接地址处理的单一事实来源，renderer 失焦/切换
  协议时调用一次，主进程配置与 Router Provider 校验时再次调用。解析部分对两种协议一致：接受
  省略 scheme、单/双前导斜杠、反斜杠、`/v1` 和完整端点；远程默认 HTTPS，本机回环默认 HTTP，
  拒绝用户信息、查询参数、片段和远程 HTTP。
- 两种协议之后的处理必须分开，混用是 2.6.0 修掉的接不上问题的根因。CCR Provider 的
  `api_base_url` 要的是完整请求地址，所以 OpenAI 走 `completeConnectionEndpoint`：`/responses`
  映射为 CCR `openai_responses`，其他 OpenAI 输入补为 `/v1/chat/completions`。而
  `ANTHROPIC_BASE_URL` 是**基址**，Claude Code 自己会追加 `/v1/messages`，所以 Anthropic 走
  `normalizeConnectionBaseUrl`：中转站发布的路径原样保留（`https://host/v1` 保持
  `https://host/v1`，`/relay/v1`、`/proxy/anthropic` 同理），只有整段粘贴 `/v1/messages` 时才
  还原回它所属的基址，粘进来的 OpenAI 端点直接报错并指向协议开关。此前把 Anthropic 也补成
  `/v1/messages` 再剥掉后缀，等于把 `/v1` 从基址里抹掉，按 `/v1` 发布的中转站因此在别的软件能
  连、在 ClaudeDock 连不上。
- renderer 仍以 `selectedProviderId | undefined` 保存精确目录项，但首屏只投影为
  `claude-subscription / chatgpt-subscription / domestic / api` 四个 access choice。国产模型从同一
  `CLAUDE_PROVIDERS` 目录生成紧凑 `<select>`，API 映射到 custom 表单；既有项目 preset 与 onboarding v2
  选择都能预选入口，不能覆盖稍后到达的项目配置。
- `form-wizard.ts` 独占 `choice/configure` 呈现状态、双向动效、进度条和底部上一步/下一步。选择 provider
  仍调用原 `applyPresetUi`，第二步继续移动同一 Router/cURL/ChatGPT 工具节点并复用原配置、历史、测试与
  保存逻辑，不复制 DOM。连接测试与修复沿既有整体 busy 状态禁用向导返回。步骤 viewport 保持 paint
  overflow 可见，避免裁切主题阴影、`:focus-visible` 和横向退场帧；最外层 control panel 继续承担页面级
  横向 containment。底部 sticky 操作区使用三列 pill grid、主题 `--mask-blur` backdrop filter 和半透明
  表面 fallback，状态列可收缩换行，按钮在窄 viewport 保留一致 caption 字号与 `--control-h-md` 高度；
  各 viewport 宽度都保持 bottom-sticky，由向导 viewport 底部安全区避免遮挡最后一排卡片。切换步骤时，
  renderer 在 DOM 重排前后读取胶囊 `getBoundingClientRect()`，将视口对齐纳入 Last 位置后，通过 Web
  Animations 从反向位移到零；关键帧只包含 `transform`，时长与缓动取 `--dur-4` / `--ease-spring`。新步骤在
  减少动态效果下直接落位，快速往返或功能销毁会先取消旧 Animation，避免迟到的完成事件清理新状态。
- `history-source.ts` 只依据历史记录的 `preset` 分类，不能按协议、显示地址或 Router 端点猜测来源：
  `anthropic` 属于 Claude 官方订阅，`chatgpt-subscription` 属于 ChatGPT 官方订阅，provider 目录中
  `domestic` 分组属于国产模型，其余已知/旧版/自定义记录都进入 API / 中转站。history state 同时保留
  `allEntries` 与按当前 provider 派生的 `entries`；保存、恢复、重命名和删除先替换完整列表，再重算
  内联列表，不能把切换来源误写成删除历史。
- `history-dialog.ts` 使用原生 `showModal()`、规范 `dialog::backdrop` 高斯遮罩和四块常驻 panel。分类切换
  只改变整条 track 的 `translate3d`，tab 使用 roving `tabindex` 并支持左右/Home/End；非活动 panel 同时
  设置 `inert` 与 `aria-hidden`。弹窗 active source 与表单 selected source 分离，打开时才以当前来源作为
  初始分类。历史右键菜单打开期间移入 dialog 顶层，关闭时隐藏并还原到 `body`；所有内联/弹窗副本共享
  同一 IPC mutation 和 busy 状态，不维护第二份记录。
- `ManagedChatGptSetupProgress.interruptible` 由 main 在发送进度时给出，当前只允许 OAuth `logging-in`
  阶段取消。renderer 同时核对 session scope；可取消时调用无参数
  `cancelManagedChatGptGatewaySetup`，主进程的 `ManagedChatGptGateway.cancelSetup()` 再检查实际仍处于
  login 子进程后才 abort 并等待回收。Proxy API 安装/启动、模型发现、真实测试和保存继续不可打断，
  不能仅靠 renderer disabled 伪造事务边界。若授权恰好在点击返回时跨入不可打断阶段，main 返回
  `ok: false`；renderer 立即锁定返回并留在第二步，不能把过期 progress 当成取消成功。
- 全局设置的“接入”分类使用原生模态 `<dialog>` 和唯一一组原有工具节点，认证来源选择由同一快照
  机制管理 `apiKeyHelperPolicy`。打开时保存服务商草稿及模态层
  内所有 `input/select/textarea` 的值与勾选状态；“取消”、关闭按钮和 `Esc` 恢复快照，
  “完成”保留当前输入。Router 安装/卸载/启停与 Provider 保存仍走既有即时 IPC，不能伪装
  成可回滚事务，界面在操作区上方明确说明这一边界。接入历史不属于高级诊断工具，因此不进入
  设置快照范围，也不会随 Router/cURL 工具节点移动；右上角分类历史弹窗仍属于接入主流程入口。
- 应用级非即时设置另有 `savedAppSettings` 基线。renderer 只在控件变化时比较开机启动、关闭行为、
  主题、对话静默超时与联网检索隔离五个字段，实时计算 `*N 项未保存`；主题可本地预览但不调用
  IPC。点击“完成”才按变化字段调用现有 setter，取消/关闭/Esc 恢复基线。首帧
  `applyTerminalTheme(..., persist=false)` 只绘制 localStorage 里的预览，主进程设置返回后再覆盖，
  因此渲染器默认值不会反向写掉上次主题。
- Kimi 开放平台与 Kimi Code 会员分为两个目录项，明确阻止密钥/基址混用；SiliconFlow 按其
  Claude Code 文档使用 `apiKey`（`x-api-key`）；Ollama 使用不落盘的 `ollama` 占位令牌。
- `ClaudeGatewayDetector` 每次最多缓存 3 秒，renderer 在“接入”页打开期间每 6 秒刷新。它用
  短连接检查 Claude Code Router 默认 `3456/3458`、CLIProxyAPI 默认 `8317` 与 LiteLLM 常用
  `4000`，不会枚举或扫描
  全部本机端口。这个探测器只描述外部工具；受管 CLIProxyAPI 的状态由
  `ManagedChatGptGateway.getState()` 携带随机本地密钥定向探测，二者不共享配置所有权。
- `BackgroundTaskCoordinator` 为安装检测、Router 状态、网关扫描、软件更新和连接实测提供
  两个并发槽。相同 key 的并发请求共用同一个 Promise，用户触发的连接实测会排在尚未开始的
  后台刷新之前；`AsyncRefreshCache` 让安装、Router 和更新检查在 TTL 内复用结果，并防止旧
  请求覆盖操作后的新状态。这些工作本身是异步网络/子进程 I/O，采用限流队列比额外占用
  Worker Thread 更合适。
- renderer 完成首屏工作区 hydration 后用零延时任务启动统一更新检查，不阻塞终端启动。标题栏
  聚合 ClaudeDock Release、Claude Code/Router npm 元数据、插件 marketplace 与当前项目 MCP
  目录/健康刷新；各 Promise 隔离失败，单一来源不可用不抹掉其余结果。软件、插件和 MCP 页同时
  保留独立入口。新增任何 update source 必须同时注册全局聚合与领域入口，
  并在 README/design/technical 中说明“检查”是否会应用更新；两条路径都不会调用模型。
- CCR 的识别依据包括 `ccr` 命令、旧版
  `~/.claude-code-router/config.json`、新版 Windows
  `%APPDATA%/claude-code-router/{config.sqlite,gateway.config.json}`，以及默认端口状态。
  只检查配置文件是否存在，不读取 SQLite 中的密钥或上游凭据。
- 对 `3456/4000/8317` 的后台探测只执行不带凭据的 `GET /v1/models`：`200` 表示可访问，
  `401/403` 表示接口已运行但需要网关访问密钥。管理页 `3458` 只做 TCP 存活判断。
- 检测会只读解析用户 `~/.claude/settings.json`、项目 `.claude/settings.json` 和
  `.claude/settings.local.json` 的 `env` 块与 `apiKeyHelper` 是否为非空字符串，只向 renderer
  传递净化后的 `ANTHROPIC_BASE_URL`、静态凭据及 helper 是否存在的布尔值；helper 命令和密钥值
  都不跨 IPC。
- `src/shared/claude/curl.ts` 在本地 renderer 中解析 cURL 的 URL、`model`、Bearer 或
  `x-api-key`。URL 的用户信息、查询参数和片段不会进入结果；解析文本不写日志。切换项目会
  清空 cURL 输入与内存中的解析结果；一键导入 Router 成功后也会立即清空。
- OpenAI cURL 可由用户主动一键写入 CCR Provider；上游密钥只发给本机 CCR 管理 RPC，
  Router 客户端密钥只由主进程写入 ClaudeDock 的 DPAPI 配置。两类密钥不会互相代用。
- 帮助按钮仅允许打开服务商目录、Claude/LiteLLM/CCR 声明的文档与控制台域名；本机管理页仅允许
  `http://localhost|127.0.0.1|::1:3458`，其他任意外链会被主进程拒绝。

### Router 安装与 Provider 管理

- `ClaudeRouterManager` 支持 Claude Code Router 3.x。它优先从 `where.exe ccr` 与标准 npm
  全局目录定位 CLI，也识别官方桌面版的标准 Windows 安装位置；不遍历磁盘或猜测任意程序。
- npm 版 CCR 必须由其安装环境中的系统 Node 运行。ClaudeDock 会从 npm 前缀旁和
  `where.exe node` 的结果中选择绝对 `node.exe`，并用一次不访问数据库的原生绑定加载探针
  验证它可以加载 CCR 的 `better_sqlite3.node`。禁止再用 Electron 的 `process.execPath`
  加 `ELECTRON_RUN_AS_NODE` 启动 CCR，因为 Electron 与系统 Node 可能具有不同的
  `NODE_MODULE_VERSION`。
- 正在运行的 CCR 会在 `%APPDATA%/claude-code-router/service.json` 记录本机管理端点、
  Web token 与 service token。主进程只接受 `http://localhost|127.0.0.1|::1` 回环地址，
  校验 service identity 后调用 `POST /api/ccr/rpc`；token 和原始配置永不跨 IPC。
- 状态、Provider 列表与操作结果只向 renderer 返回净化后的 URL、模型和
  `credentialConfigured` 布尔值。RPC 响应限制为 8 MiB，超时或错误消息会再次清除已知
  token 与凭据。
- Provider 保存先结构化克隆 CCR 的完整配置，只修改 `Providers` 与
  `preferredProvider`，然后调用 `saveConfig(config, { applyProfile: false })`。未知字段、
  媒体能力、Codex/Claude profile 与 proxy 原样保留；删除也只移除目标 Provider。项目不会
  调用 CCR 的 profile 应用或系统代理方法，因此不会修改 Codex、Claude Code 全局设置或
  Windows 系统代理。
- CCR 3.x 运行期按 Provider 名称解析 `preferredProvider`。兼容读取时同时接受旧配置中的
  Provider ID，以便正确显示首选状态；编辑、设为首选或删除时会把该字段规范化为当前
  Provider 名称。
- Provider 名称和模型路由只接受可安全组成 `provider/model` 的字符；远程上游必须为
  HTTPS，本机回环地址允许 HTTP，URL 禁止用户信息、查询参数和片段。Provider 密钥不会
  回显，编辑时可显式保留原值。
- “用于当前项目”会取得 CCR 当前 API 端点、路由模型和 Router 客户端密钥；密钥直接交给
  `ClaudeConfigStore` 用 Windows DPAPI 保存，不经过 renderer。最终只影响 ClaudeDock 为
  当前项目启动的 Claude Code 子进程。
- `router-repair-from-project` 只接受当前项目的 HTTPS Anthropic 直连、`apiKey` 认证和
  已加密保存凭据。主进程把规范化基址转换为完整 `/v1/messages` Provider，使用
  `applyProfile: false` 保存，确认 `3456` 启动成功后才把项目切到 Router；凭据不跨 IPC。
  Bearer、无认证、已有 Provider 或项目已指向 `3456` 时拒绝自动复制并引导手动配置。
- CCR 返回 `No available models` 或 Provider 列表为空时，主进程将其映射为中文原因和
  下一步，不向 renderer 透传英文错误；其他错误在显示前会净化 Bearer 与 `sk-` 形态。
- 如果现有 3458 管理服务返回 `better-sqlite3` ABI 不匹配，状态会携带
  `runtimeMismatch` 并显示编译/运行时 ABI。用户点击修复后，主进程仅在错误模式明确匹配时
  终止 `service.json` 中已通过 service token/identity 校验的单一 PID，等待它退出，再用
  兼容系统 Node 执行 `start --no-open --gateway`；不会按映像名批量杀进程，数据库、
  Provider、CCR profile 和 Codex 均不改写。`ccr_web_token` 也会在错误净化时隐藏。
- 部分错误服务在真正访问 SQLite 前会先返回空配置。为避免再次误报“No available
  models”，主进程还会用 `tasklist.exe` 按 service PID 核对进程映像；只有映像名与当前
  ClaudeDock/Electron 可执行文件完全相同时才提前标记 `runtimeMismatch`，官方 CCR 桌面
  进程和系统 `node.exe` 不受影响。`tasklist` 原始字节同时尝试 UTF-8 与 Windows
  GB18030 解码，以覆盖中文产品名；结果按 PID 缓存，避免轮询重复创建进程。
- 启动只接受系统 `node.exe` 承载的 CLI 后台；检测到 CCR 桌面进程或无法确认的进程时拒绝接管。
  受支持的 CLI 启动参数固定为 `ccr start --no-open --gateway`。停止先调用 `stopGateway`，再只对
  经 `service.json` token/identity、PID 和映像核验的 `node.exe`/旧 ClaudeDock CLI 子进程发送
  `SIGTERM` 并等待最多 10 秒；永不结束 CCR、Claude 或 Codex 桌面 App。
- 一键安装只通过固定包名 `@musistudio/claude-code-router@latest` 调用 npm，不再下载或打开 Windows
  桌面安装器。首选 `https://registry.npmjs.org`，命令失败且 npm 本身存在时可见地回退
  `https://registry.npmmirror.com`；registry 只作为本次 argv 传入，不写入用户 npm 配置。
  `WindowsCommandOptions.env` 合并 ClaudeDock 为 CLI 配置的 HTTP 代理并显式删除 null 覆盖，
  因而 npm 能沿用用户第一跳代理，同时保留 `NO_PROXY` 的本机回环地址。
- `installInFlight` 把并发安装调用合并为一个 Promise。主进程按检查、下载、安装定位、验证、完成/
  错误广播 `RouterOperationProgress`，renderer 同时更新阶段面板和安装按钮上方状态卡；阶段号来自
  主进程，不用静态灰按钮猜测进度。
- 每次 npm 写入前把最小 `RouterOperationJournal` 原子保存到
  `userData/claude/router-operation.json`。记录仅含 schema、操作、npm/npmmirror 来源、阶段和时间戳，
  不含 URL、代理、凭据或模型。成功校验 CLI 后删除；断电/崩溃后窗口创建完成即调用
  `recoverInterruptedInstall()`，幂等重跑 npm 安装并再次校验。恢复失败保留 journal，不删除缓存、
  Provider 或共享数据，也不给小白用户展示技术清理选择。
- OpenAI 上游保存时若 CLI 未安装会先自动安装；向导先通过上游 `/v1/models` 获取可选模型，随后
  启动管理后台、以 `applyProfile: false` 保存 Provider，再显式调用 `startGateway` 并轮询确认 3456
  已运行。管理页 3458 可用但首个 Provider 尚未写入不再被视为失败，也不会提示用户去后台手动启动。
  最终项目配置只有在真实请求通过后才保存。`RuntimeSession.routeKind` 记录真实活动路径；最后一个
  `ccr` 会话结束、切到不需要
  路由的直连/中转或切换项目到 Codex CLI 后自动停止 CCR，仍有其他活动 CCR 会话时保持运行。
- 卸载只针对检测到的 npm CLI：先用固定包名执行全局卸载，再针对原安装 prefix 重试，最后只清理
  已验证的包目录与同目录 shim。若同时存在桌面版，完整保留共享 CCR 数据；只有机器没有桌面版时才
  允许按 `routerDataDirectory()` 路径牢笼删除共享数据。`canUninstall` 仅由 CLI 是否存在决定。
- 标准桌面安装位置仅用于显示 `desktop/mixed` 与进程保护状态。ClaudeDock 不启动桌面可执行文件，
  不查找/打开卸载器，不写 App profile；这条边界由本节架构契约和源码守栏测试固定。

### 3.0 路由决策与 CC Switch 边界

- `src/shared/router/capabilities.ts` 为供应商目录的每个 ID 明确记录 `direct-anthropic`、
  `router-optional` 或 `router-required`、认证方式、默认模型和 `verifiedAt`。自动接入向导按能力直接
  选择直连或 CCR，不把路由开关交给普通用户；只有 OpenAI 协议转换才强制路由。DeepSeek 按 2026-08-02
  官方 Claude Code 集成指南使用 Anthropic 兼容 `authToken`、`https://api.deepseek.com/anthropic`
  与当前模型标识，供应商原始“模型不存在”等错误不再被静默小型/备用模型降级覆盖。
- `chatgpt-subscription` 的能力值为 `direct` 只表示 ClaudeDock 不再叠加 CCR；真正的协议转换仍由
  ClaudeDock 下载并管理的独立 CLIProxyAPI 回环 sidecar 完成。CC Switch 不参与这条流程。界面和
  技术文档必须同时保留“非官方直连”标签，不能从该枚举值推导为 OpenAI 或 Anthropic 官方支持。
- 向导阶段固定为决策、检查/安装内核、启动、写 Provider/项目配置和 1-token 连通校验；每个
  阶段通过 BusyRegistry 与下载内核暴露真实状态。CCR 的所有配置写入只能经过
  `saveConfigWithoutProfileTakeover()`，唯一 `saveConfig` 调用永久传 `applyProfile: false`，
  源码守栏测试禁止桌面 profile takeover 和系统代理写入。
- `CcSwitchAdapter` 只从官方 GitHub Release 元数据接受带尺寸与 SHA-256 的 Windows MSI，安装/
  卸载交给 `msiexec` argv。检测只查询卸载注册表、`ccswitch://` 协议和进程，不打开数据库；
  Provider 互操作只调用官方 `ccswitch://v1/import` 单向深链。清理仅限 APPDATA/LOCALAPPDATA 下
  已知 CC Switch 专属目录，路径不在牢笼内即拒绝。
- `src/shared/router/kernel.ts` 以纯状态计算 CCR 与 CC Switch 的 installed/running/conflict 真值。
  两者同时运行时界面阻断新的路由接入并要求用户显式保留一个；安装、卸载、导出和残留清理均为
  可验证的显式操作，不伪造 CC Switch 不存在的管理 API，也不读写其 SQLite。

### 软件与插件更新

- `SoftwareUpdates` 只并发读取 npm 官方 registry 与 npmmirror 的 Claude Code/Router `latest`
  元数据，接受首个结构有效的版本；单源上限 8 秒，避免先等慢官方源再等镜像。ClaudeDock 不再请求
  GitHub Releases API，也不在这个状态中保留第二份应用版本权威。所有请求使用 `ClaudeRuntime` 注入的
  `session.defaultSession.fetch()`，因此“ClaudeDock 自身网络”作用域启用时会经过用户配置的外部代理，
  未启用时继承 Windows system proxy；结果缓存 5 分钟，轮询只在缓存到期后产生请求。
- `ApplicationUpdaterService` 是 ClaudeDock 版本、下载和安装状态的唯一权威，包装
  `electron-updater` NSIS updater，仅在 `app.isPackaged && win32` 启用。打包的 `app-update.yml`
  固定一个无凭据 COS generic feed，并设置 `useMultipleRangeRequest: false`；`5.0.0-rc.N` 读取
  `rc.yml`，稳定版读取 `latest.yml`。首次加载和手动刷新执行可合并的 check-only，不开始下载；显式
  “下载并更新”IPC 才调用 `downloadUpdate()`。`autoDownload/autoInstallOnAppQuit` 均关闭，进度通过 IPC
  推送；同一显式交易收到 `update-downloaded`、确认 SHA-512 一致后，先把退出闩置位并清理 ClaudeDock
  拥有的进程，再自动调用 `quitAndInstall(true, true)` 静默安装并在完成后重新启动，不要求第二次确认。
  check-only、后台刷新和孤立的
  updater 事件都没有这项安装授权；并发下载与安装请求分别合并为一个操作。应用更新在“全部更新”中
  固定最后执行，避免进入退出安装后再启动其他更新。清理、启动安装器失败或 updater 在 `installing`
  阶段异步报告错误时撤销退出闩、进入 `error`，进程观察器保持运行以允许重新检查；成功后由标准
  `before-quit` 清理停止观察器。显式关闭
  降级与 web installer，blockmap 支持差分下载；下载完成仍保留完整预发布版本字符串。
- 通道清单 SHA-512 证明安装包与所读取元数据一致，不证明发布者身份。当前安装包 Authenticode 为
  `NotSigned`，通道清单未签名，配置没有 `publisherName`；`update-downloaded`、TLS 可用或摘要通过均
  不得标记为“供应链已验证”。
- `src/shared/ui/update-actions.ts` 把检测结果纯函数化为 `hidden / install / update`：状态尚未
  返回时不显示操作；目标未安装时显示安装；只有已安装且 `updateAvailable` 为真时显示更新。
  插件“更新全部”同样要求 `updatesAvailable > 0`，单插件更新按钮则直接受该插件的
  `updateAvailable` 控制。
- 标题栏 `refresh-updates` 是全局主动检查入口，不是唯一入口。首屏自动检查和用户点击会并行
  处理全部已注册来源，图标以 `aria-busy`/旋转反馈过程，以琥珀点和动态 `aria-label` 表达已发现
  数量；用户主动检查完成后始终打开统一更新对话框，按 ClaudeDock、Claude Code、Router 与插件
  生成可执行行，支持逐项或全部执行，没有更新时显示明确空状态。单一来源失败只禁用对应行，
  其他结果仍可操作；操作开始后与 `BusyRegistry`、下载内核和应用更新器状态一起汇入下载中心。
  各领域页仍可单独刷新。软件/插件/MCP 检查本身不安装内容；应用代理测试是独立动作，不属于
  全局更新聚合，也不会调用模型。
- Claude Code 先按 `Get-Command claude` 的可执行文件判断 `native/npm/unknown`。官方原生路径使用
  固定 `claude update`；未安装时使用固定 winget ID `Anthropic.ClaudeCode`。只有 npm 安装才并发
  请求两条 registry 的结构化元数据，并对同主机 HTTPS tarball 发 `Range: bytes=0-131071` 小样本；
  按样本字节率、再按元数据延迟选择 npm 或 npmmirror，固定包名和 registry 均不含用户输入。
- `ClaudePluginManager` 调用 `claude plugin list --json --available` 与 marketplace JSON
  接口。插件标识、市场名和市场来源分别经过格式校验；变更后强制刷新目录。CLI 返回版本或
  source SHA 时与市场记录比较并标记更新；统一刷新会先执行官方 marketplace update，确认
  有新版后才允许单个或批量执行官方 `plugin update`。
- **CLI 对已装与可装插件的描述形状不同**，这是曾经导致已安装插件两边都看不到的原因：
  `available` 条目带 `pluginId` / `name` / `marketplaceName` / `description`，而 `installed`
  条目**只有 `id`（`plugin@marketplace`）**，没有 `name`、没有 `description`，`version` 常为
  字符串 `"unknown"`；同时 CLI 已把已装插件从 `available` 里剔除。因此 `parsePluginEntry`：
  - `pluginId` 依次接受 `pluginId` → `id` → `name@marketplaceName`；
  - `name` / `marketplaceName` 缺失时从 `pluginId` 按 `@` 拆分反推，市场名兜底为 `本地`；
  - `version === 'unknown'` 归一化为 `undefined`，既不显示 `vunknown`，也不会与市场版本
    比较出虚假的「可更新」。
- `installed` 缺失的说明与来源由 `enrichInstalledPlugins` 用市场清单补齐：清单读自
  `parseMarketplaces` 返回的 `installLocation` 下的 `.claude-plugin/marketplace.json`
  （读取函数以参数注入，便于单测）。只在字段仍是兜底值时才覆盖，CLI 自己给出的说明优先。
  市场清单读取失败不影响已成功解析的插件。
- `src/shared/ui/plugin-localization.ts` 不调用外部翻译接口。它按安全、测试、API、数据、运维、
  前端等可追踪关键词生成中文能力概括；renderer 只展示中文概括，插件 ID 始终使用 CLI
  返回值，搜索仍覆盖原文、中文概括与分类。该概括属于项目自研规则，不是插件作者译文。
  插件命令的英文标准错误不会直接进入界面，而是映射成中文操作提示。
- Windows 上 `claude`/`npm` 常由 `.ps1` shim 提供。`WindowsCommand` 先用固定 PowerShell
  查询 `Get-Command` 的绝对 `Source`，再通过 `-File` 与独立 argv 调用；stdin 显式连接
  NUL，避免 Claude CLI 把匿名管道当作慢输入等待。`.cmd` 只在同目录存在配套 `.ps1` 时
  转用该脚本，不启用字符串 shell。

### 连接实测

- `ClaudeConnectionTest` 根据基址追加 `/v1/messages`；用户若粘贴完整
  `/v1/messages`，保存时会先规范化为基址。测试请求固定 `max_tokens: 1`、非流式和
  单字符提示。未保存表单只在用户点击“测试并接入”时执行；当前项目的已保存配置会在
  Claude 状态首次载入、窗口从托盘隐藏态恢复，以及用户点击底栏连接按钮时执行。
- OpenAI 表单测试先创建或更新 CCR Provider 并启动本机 Router，再对最终 3456
  `/v1/messages` 路由执行同一套单令牌测试；因此测试覆盖的不只是上游 HTTP 存活，而是 Claude
  Code 实际会使用的完整协议转换路径。测试成功后 renderer 才保存项目配置。
- Bearer 对应 `Authorization: Bearer`，API Key 对应 `x-api-key`。返回非空 ID 和 `content` 数组
  即按 Anthropic Messages 兼容响应通过，不再要求服务商复制 Anthropic 的 `msg_` 编号前缀；
  明确出现 `choices` / `chat.completion` 才标记为 OpenAI，未知 200 正文不自动建议协议转换。
  `401/403` 定位为认证错误，
  `404` 提示可能误填 OpenAI 地址，`400/422` 作为“端点与认证基本可用、模型或字段需处理”
  的警告。
- 主进程通过 `ReadableStream` 最多读取 64 KiB 响应体，达到上限立即取消余下正文；只抽取
  180 字符的结构化错误消息并再次清除当前凭据，成功响应正文不返回 renderer。15 秒超时或
  网络错误只回传分阶段诊断。
- 已保存凭据从 `safeStorage` 解密后仅用于该次测试；表单新输入可在保存前测试。测试结果
  不包含凭据或模型回复文本。
- `src/shared/claude/connection-remedy.ts` 把安装门禁、Router 生命周期、401/403、404、
  400/422、超时/网络、200 非标准响应和 Kimi 密钥族不匹配映射为结构化原因、建议与动作；
  renderer 只负责执行打开控制台/文档、切认证、用小型/备用模型、安装/启动 Router、重试或重选。
- 补救动作由 `connectionRemedyInProgress` 串行化；开始后 provider picker、配置表单和补救动作区
  全部 inert/disabled，容器设置 `aria-busy`，唯一 `finally` 恢复。Router 安装不改变当前服务商
  和未保存草稿，避免“处理中”期间配置被静默替换。
- “测试并接入”严格串行：真实测试 `ok` 后才调用保存；“跳过测试并保存”是明确的次操作。
  该按钮不用通用 `runGuarded` 包裹，因为成功路径会嵌套保存并重新渲染控件；它由
  `connectionTestInProgress` 单独防重，并在唯一 `finally` 中先清 busy 状态和原文案，再让
  `syncConnectionInteractivity` 按最新环境重算 disabled。这样成功、失败、异常和保存后的重绘
  都不会把测试前快照中的 disabled 状态永久写回。测试期间跳过 6 秒轮询并禁用服务商/配置
  控件，但不阻断导航或 PowerShell 输入。
- renderer 用 `automaticConnectionTestSessions` 按 session ID 去重：`renderClaudeState`
  在当前项目与开发引擎确认是 Claude 后调度一次已保存配置实测。主进程仅在窗口从隐藏或最小化
  状态经 `showMainWindow()` 恢复时发送 `app:window-restored`；preload 暴露受限订阅，renderer
  清除当前项目的去重标记后再调度一次。窗口一直可见时的 focus、Alt+Tab、visibility 事件不
  清除标记，避免反复消耗 token。若测试队列正忙，自动任务延后重试而不并发。
- `claude:test-connection` 在主进程重新校验输入。`provider === 'anthropic'` 时先执行
  `ProviderAccessGuard.assertAllowed('anthropic-claude', 'first-request', cwd)`，通过后才向
  官方模型接口发出最小请求；`gateway`（中转站、自定义网关和本地转换器）跳过官方服务商
  预检并直接验证自己的已保存端点。预检是额外防护，不替代真实连接测试。
- 每次测试按“规范化配置 + 凭据 SHA-256”生成内存指纹，只在当前项目保存的配置与凭据完全
  匹配时显示到会话页；不会持久化凭据摘要。最小请求通过是一个时间点信号，不能证明上游
  持续在线，也不能覆盖 Claude Code 后续的流式内容、工具调用和更大请求。

### 会话路由健康

- `ClaudeProjectState.routeHealth` 统一表达连接测试、Router 状态与真实会话三种来源，包含
  success/warning/error、检查时间、说明及是否阻止启动。renderer 在会话页显示健康卡，
  新错误同时触发一次 toast。
- 只有当前项目的基址确实是本机回环 `http://*:3456` 时，启动前才读取 CCR 状态；Provider
  为空或 gateway 非 running 会在重启 PowerShell 前阻断，并引导到接入页。远程直连和其他
  本机端口不会被无关 CCR 故障影响。
- `ClaudeRuntime.consumeTerminalOutput` 保留最多 4 KiB 的短期诊断窗口，只识别 Claude
  Code 明确输出的 `API Error:`。ConnectionRefused、401/403、404 与模型错误映射为可读
  原因；通用错误在截断前清除 Bearer 与 `sk-` 形态。诊断窗口、终端正文和提示词都不落盘。
- 新会话启动会清除旧运行错误；当后续 statusLine 指标时间晚于错误时也视为恢复。若同一
  配置先通过 1-token 测试、后在真实会话失败，健康卡会明确解释“测试成功不代表持续可用或
  完整兼容”，避免把两种结果误认为矛盾。

### 会话、上下文与用量

- Claude Code 的一个 conversation 是一个 session，并与启动目录绑定。新运行 `claude`
  创建新 session；`--continue` 续接当前目录最近的 session；`--resume` 打开会话选择器；
  `/clear` 保存旧会话并用空上下文创建新 session。
- Claude Code 会把当前项目的会话 JSONL 存在 `~/.claude/projects/<project>/`。ClaudeDock
  不复制、索引或向 renderer 返回正文；历史列表读取 JSONL 结构时只提取元数据，运行中用量
  仍只显示 Claude Code `statusLine` 提供的结构化数字。
- 历史会话列表只进入当前工作目录编码后对应的项目目录，并只读取目录顶层 UUID 命名的
  `.jsonl` 文件。标题优先级为 `customTitle > aiTitle > sessionName > slug`，避免把随机
  slug 当作用户可读名称；其余只提取 session ID、时间、模型和 usage 等元数据，不跨项目
  枚举。单文件超过 50 MiB 时跳过。渲染层只在项目文件夹的折叠层级中展示历史，不在工作台
  重复生成第二份列表；历史条目全部渲染进 `.project-folder__history` 独立滚动容器（约六行
  高）。容器使用 `align-content: start` 和内容行轨道，每行至少 27px；13 条夹具在 170px 可视高度
  中产生约 375px 滚动高度，而不是缩小文字。运行中对话保持在容器上方不动，滚动位置按文件夹记录、在侧栏因工作区状态刷新而
  重建后恢复。文件夹的展开状态只控制历史区：`expandedFolders` 不再被活动会话强制置为
  展开，收起使用中的项目时保留运行中对话行、只隐藏历史与提示区。
- 历史枚举同时排除原生对话 owner 与安全终端 owner 的 conversation UUID。终端已经打开但尚未收到
  statusLine 时也不会在历史列表再渲染一行，从而避免同一对话在“运行中”和“历史”区域重叠。
- 历史右键重命名先验证项目路径、UUID、文件类型、50 MiB 上限和 1–60 字符标题，再向对应
  JSONL 追加 `type: "custom-title"` 记录，不重写正文。运行中重命名先更新工作区标题；若该
  PTY 正在运行 Claude Code，再发送白名单 `/rename <title>` 让 Claude 元数据同步更新。
- 历史删除的 renderer 入口同时存在于每行 `×` 与右键菜单，两者调用同一应用内危险确认。
  删除 IPC 传入的是项目路径与 conversation UUID，不再依赖某个仍存活的终端 ID；主进程重新
  规范化项目路径并校验 UUID，`ClaudeSessionManager.deleteSession()` 最终只允许删除编码后
  项目目录下精确的 `<uuid>.jsonl`。若 statusLine 表明同一 conversation 正在运行，renderer
  先通过现有 `project:close` 停掉对应 PTY，成功后才删除。
- Claude Code 2.1.220 的公开 CLI 没有单会话删除命令；`claude project purge` 会清空整个
  项目范围，不能用于本功能。因此当前实现明确属于现有的严格兼容删除路径，不宣称为官方 API。
- Claude Code 2.1.196+ 会用小型模型根据首条提示词生成短标题；官方 statusLine 的
  `session_name` 在存在 `/rename`/`--name` 自定义名称时返回自定义名称，否则返回该 AI 标题。
  ClaudeDock 已要求 2.1.197+，因此直接把这个字段同步到对应 `TerminalWorkspace` 标题，不再
  额外运行 `claude -p`、不注入隐藏提示词，也不解析终端绘制文本。工作区记录每个 PTY 最近
  看见的 Claude 标题：手动重命名后重复到达的旧状态行会被忽略，直到 Claude 返回一个新名称，
  避免 `/rename` 处理期间界面短暂回退。
- 渲染层在 `renderWorkspace` 中对比每个会话上一次渲染的标题：标题变化且非手动重命名时，
  启动与 DOM 解耦的打字机动画（保留公共前缀 → 逐字擦除 → 逐字输入，间隔加轻微随机抖动，
  `data-title-typing` 驱动 CSS 光标）。动画状态存于 Map，侧栏因工作区刷新重建时读取当前
  帧续播；会话关闭时清理定时器。手动重命名通过一次性抑制集合跳过动画，
  `prefers-reduced-motion: reduce` 下不播放动画、直接落最终标题。
- 定向恢复把经过 UUID 校验的 session ID 交给统一的 PowerShell 命令构造器，因此继续保留
  参数单引号转义、凭据环境清理和不可见退出标记；可见 PTY 只收到固定短触发词，内部命令不进入
  PowerShell 历史。启动不再附加 `--no-chrome` 或重复的 CLI `--model`。删除同样限定为当前项目
  目录下的精确 `<session-id>.jsonl` 文件。
- `assets/runtime/claude-statusline.ps1` 从 stdin 接收官方 statusLine JSON，原子写入模型、
  session ID、session name、上下文窗口、输入/输出 token、估算费用、持续时间、改动行数、
  `effort.level` 和 `fast_mode`。解析层只接受 `fast_mode` 的真实布尔值；字符串或数字不会被当成
  Fast 已开启。`effort` 只在当前模型带思考程度参数时出现，缺失时 `effortLevel` 写入 null，
  由渲染层回落到本次请求值，而不是伪造默认档。
  stdin 必须显式按 UTF-8 解码（`StreamReader` + `UTF8Encoding`），不能用 `[Console]::In`：
  中文 Windows 的控制台代码页是 GBK，多字节 `session_name` 会被解错，双字节读还可能吞掉
  JSON 的结尾引号导致整个解析失败——症状是恢复带 AI 标题的历史会话后完全没有指标，而全新
  （未命名）会话正常。主进程每秒读取变更，通过受限 IPC 推送，同时把有效的 1–60 字符
  session name 同步到工作区标签。
- 上下文占用优先累加 `context_window.current_usage` 的 `input_tokens`、
  `cache_creation_input_tokens` 和 `cache_read_input_tokens`，并限制在当前窗口内；官方
  `used_percentage` 只计算这三项，因此 `output_tokens` 不加入占用百分比。仅在这些字段全部
  缺失时才回退到 `used_percentage × context_window_size`。不使用累计 `total_input_tokens`，避免把
  已压缩的历史反复计入，也避免取整后的百分比让底栏长期误显 100%。界面的“实时”表示每次
  statusLine 刷新后的最新状态，不代表逐 token 流式计数。
- Claude 上下文窗口由底栏资源菜单显式声明（自动 / 100 万 / 20 万 / 自定义），持久化在
  `app-preferences/app.json` 的 `claudeContextWindowMode`。默认 `auto` 不声明窗口；显式档位仍写入
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 与
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`，但 Claude Code 2.1.233 对已识别的普通 `claude-*` 模型不会
  单靠 `MAX_CONTEXT` 扩到 1M。选择 100 万（或自定义恰为 100 万）时，launch-only model 因此使用
  `<canonical-model>[1m]`；Claude Code 据此选择 1M profile，并在发送上游请求前剥离后缀。
- `[1m]` 只存在于运行边界：PTY 的临时 `settings.model`、窗口相关 model 环境与会话内 `/model`，以及
  Agent SDK 的显式 `options.model` / `query.setModel`。配置存储、连接指纹、恢复记录、模型选择 UI 与
  `expectedModel` 始终保留 canonical model；模型对账忽略后缀。这样网关继续接收原模型名，切换模型
  也不会把一个已扩展的会话悄悄降回 20 万。
- 托管 ChatGPT 预设始终由自己的 272K / 1.05M profile 占用同一组变量，无论通用 Claude 偏好为何
  都不被覆盖；两组选择器在 UI 中也互斥。原生 Agent SDK 尚未上报容量时，底栏把数值标为“配置目标
  （未验证）”，而不是伪造 `claude-statusline` 来源。
- statusLine 的 `contextWindowUsed` 与原始 `inputTokens` 不一致时置 `contextCountingAnomaly`，用于提示
  计数或配置不一致；该组合本身不能证明端点容量。只有 `parseClaudeContextWindowError` 识别到真实
  上下文拒绝（包括 `prompt is too long` 及网关简写）才建议切到 20 万。提示按会话、PTY generation
  与当前请求档位去重，重启或改档后可以再次出现。
- 软件不声称自动探测端点真实窗口：`/v1/models` 通常不返回容量，模型字符串目录也不能证明账号
  entitlement 或中转映射。界面展示用户请求值与新会话真实上报值；先前未发网络请求却标成 `api`
  的 detector/probe 原型及悬空 IPC 已删除。
- 受管 ChatGPT 仅在模型为 `gpt-5.6-sol`（或兼容别名 `gpt-5.6`）时注入窗口 profile。标准档
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000`，按 Codex 产品的 95% 有效留量显示 258400，并用
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=258400` 与 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` 在 206720
  左右提前压缩；扩展实验档对应 1050000 / 997500 / 798000。启动环境同时显式清除继承的 `DISABLE_AUTO_COMPACT`
  与 `DISABLE_COMPACT`，偏好由 `AppPreferencesStore` 保存并只在下次启动会话时取值。
- Claude Code 2.1.233 对非 Claude 模型标识会在未禁用 compact 时读取
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`；官方环境变量页的通用描述仍写着该变量需配合
  `DISABLE_COMPACT`。因此 ClaudeDock 不把偏好值直接冒充实测：只有 statusLine 真正上报
  272000/1050000 时才换算 95% 有效窗口；若仍上报 200000，界面保留 200000，并按这个较小实测
  窗口计算约 160000 的提前压缩线。该兼容性需要随 Claude Code 升级持续回归。
- `parseClaudeContextWindowError` 专门识别压缩期间及普通请求的 400 上下文溢出；运行态错误不回显
  原始请求或凭据，标准档提示新建会话，扩展档额外说明订阅后端可能仍按较小产品窗口拒绝并建议
  切回标准档。已经越界后再发 `/compact` 仍可能被上游拒绝，因此不能把手动压缩描述为保证恢复。
- `ResourceUsageView` 统一表达上下文、重置窗口和余额能力。Claude 用 statusLine 获取上下文及其
  已上报的 5 小时/7 天窗口，并只对 DeepSeek 官方 `/user/balance` 与 OpenRouter 官方 `/api/v1/key`
  做有界、缓存的余额读取；Codex 从官方 App Server 的 rate limits 映射 5 小时/7 天窗口。受管
  ChatGPT 网关的本地请求统计保持禁用，不能当成官方订阅剩余额度。
- 费用是 Claude Code 客户端本地估算：订阅用户不等同于账单，第三方模型若缺少定价元数据
  也可能为空或不准确。网关在服务端替换模型无法由客户端进行密码学证明；界面只能核对
  statusLine 报告的运行模型与锁定模型是否一致。

### 运行中换模型、权限模式与思考程度

**模式真值来自终端徽标。** Claude Code 的 statusLine JSON 里没有 `permission_mode` 这个
字段（逐条核对过官方字段表），SessionStart hook 的载荷也不带它。唯一持续可读的来源是
TUI 自己重绘的模式徽标：`⏸ manual mode on` / `⏵⏵ accept edits on` / `⏸ plan mode on` /
`⏵⏵ auto mode on` / `⏵⏵ don't ask on` / `⏵⏵ bypass permissions on`。
`parseClaudePermissionMode` 位于 `src/shared/claude/permission-mode.ts`，先去掉 CSI/OSC、
折叠空白，再取位置最靠后的完整徽标。

Claude Code 的 Ink 界面会用光标移动只重绘发生变化的单元格。实测从 manual 切到 accept edits
时，PTY 新增数据不是完整的 `accept edits on`，而是带 `CSI n C` 的字符残片；直接剥掉控制序列
会得到 `ccept edits on`，旧的主进程原始字节解析因此会误报“没有响应”。renderer 为每批排队的
PTY 数据递增 `outputRevision`，只在 `terminal.write(..., callback)` 完成后推进
`appliedOutputRevision`。主进程需要切换前/后的快照时，通过双向 probe IPC 主动请求；renderer
等请求时点之前的修订全部应用后，从 `terminal.buffer.active` 的完整活动缓冲区逐行读取
`translateToString(true)`，解析徽标并带 probe ID 回报。主进程重新校验 session ID、probe ID
与六种已知模式，再更新闭环状态。4,000 字符原始诊断缓冲只保留为完整首帧的启动兜底和
API Error 识别，不再承担屏幕差量重建。

**列表点击是闭环步进，不是盲按 N 次。** `auto` 是否出现在 `Shift+Tab` 循环里取决于账号、
模型和供应商，客户端无法先验判断，所以「算差值按 N 次」一定会在某些账号上切歪。
`setPermissionMode` 先主动取一次屏幕快照：没有完整徽标时直接停止且不发送任何按键，避免
`Shift+Tab` 落进选择器、确认框或其他交互上下文。确认当前模式后才写一次 `ESC [Z`（xterm 对
`Shift+Tab` 发的就是这段 CBT 序列），再以 50ms 轮询主动快照、最多等待 2 秒；只有观察到不同
模式才进入下一步，命中目标立即停止。已访问模式保存在集合里，一旦回到旧模式就判定目标不在
当前循环中；单步没有得到确认时也停止，不会为了“碰碰运气”继续发键。`modeSwitchLocks` 按
sessionId 串行化，两次快速点击不会把按键叠在一起。渲染层只报告 xterm 当前屏幕的事实，
不按菜单点击乐观改状态；底栏永远显示主进程校验后回传的徽标。

**两个模式进不了循环。** `bypassPermissions` 无法在未预置的会话中进入（官方明确说明），
必须启动时带 `--allow-dangerously-skip-permissions`（加入循环但不激活）或
`--permission-mode bypassPermissions`（直接进入）。ClaudeDock 采用前者，按项目持久化在
`claude-config-store.ts` 的 `allowBypassPermissions`，默认 `true`；这个字段刻意不放进
`NormalizedClaudeConfig`，因为它左右的是启动命令而不是模型路由，保存接入配置时也必须
原样带过去，不能被静默重置。`dontAsk` 永远不在循环里，只能 `--permission-mode dontAsk`
启动，因此它走重启路径。

**换模型分同 profile 与需重启。** `getClaudeModelOptions` 合并当前配置与该项目的接入历史，
先按 `provider|preset|authMode|apiKeyHelperPolicy|baseUrl` 判定 `sameEndpoint`，再比较目标模型解析出的
speed mechanism/mode signature。只有端点和速度 profile 都相同才向运行中的会话提交
`/model <model>`；否则必须重建 PTY，因为 `ANTHROPIC_BASE_URL`、凭据、helper 策略、
`CLAUDE_CODE_EXTRA_BODY` 与 Claude `fastMode` 都是在 spawn/settings 阶段定死的。
热切模型后由既有的 `expectedModel` / `modelMatches` 漂移检测核对 statusLine 报回的真实模型。
模型列表的 `activeModel` 优先取本次会话已提交的 `expectedModel`，其次取 statusLine 的 `modelId`，
最后才回落到项目默认配置。

Claude Code 的 TUI 会把同一 PTY 写入中的命令正文和尾随回车视为一次粘贴，可能吞掉回车。
`switchModel` 因此不能写 `` `/model ${model}\r` ``：它与 `/compact`、命令页白名单动作一起
进入 `commandSubmissionQueues` 的 per-session 队列，再复用
`writeTerminalSubmission(buildTerminalSubmission(...))` 先写正文、等待 40ms、单独写 `\r`。
队列防止快速操作把两条命令的字节交错；间隔两侧都检查 session 对象仍是当前且 `active`，并
执行 `SessionOperationCoordinator` 传入的 ownership assertion。会话停止、重启或被更新的操作取消时
不向替代 shell 写迟到的正文/回车。只有两段均成功写入后才更新 `expectedModel`。
renderer 的模型按钮在 `try/finally` 内维护 `disabled` 与 `aria-busy`，结束时先直接恢复并重绘
已有状态，再异步刷新，因此状态读取延迟或失败不会把按钮永久锁住。

`claude:switch-model` 是独立 IPC，不放宽 `/model` 的斜杠命令白名单（仍是
`['/model', false]`，不接受参数）。handler 收到的只是一个选项 ID，主进程重新生成一次选项
列表核对，模型串再过一遍 `MODEL_NAME_PATTERN`，才写进终端；渲染层给不出任意字符串。

**思考程度只走 `/effort`，永不重启。** `src/shared/claude/effort.ts` 是唯一目录，主进程校验和
底栏菜单共用它：`auto`、`low`、`medium`、`high`、`xhigh`、`max`、`ultracode`，按推理深度升序。
`--effort` 启动标志不接受 `auto`（CLI 自己报 `Unknown --effort value 'auto' — ignoring it`），
所以 `auto` 只作为 `/effort` 的参数存在，这也是这里不复用启动标志的原因。`ClaudeRuntime.setEffort`
复用 `submitClaudeCommand` 的 per-session 队列提交 `/effort <level>`，与换模型同一套「正文 →
40ms → `\r`」写法；任何档位都在运行中的对话里生效，不需要新 PTY，这是它与 `dontAsk` 和跨端点
换模型的根本区别。

高档位不能靠删除选项“修复”。`setEffort` 在提交 `auto` / `xhigh` / `max` / `ultracode`
前，原子更新本会话命令行 settings（临时文件 → `renameSync`），写入
`alwaysThinkingEnabled: true`；metrics 发现继承来的 `xhigh` / `max` 时也执行同一准备。
这个 settings 文件不含凭据，不会改写用户的 `~/.claude/settings.json`。同时，受管环境清空
三个会覆盖 thinking / effort 的继承变量，避免界面显示能调、子进程却继续被父环境锁死。

**Web 研究与主推理解耦（可选，默认关闭）。** 这套机制是给「模型调到 high 以上就无法联网检索」
的缺陷中转站用的兼容开关，位于全局设置的“高级设置”页，由 `AdvancedSettingsStore`
（`userData/advanced/settings.json`，version 2，0o600 原子写）持久化，`ClaudeRuntime` 在每次
启动会话时现读一次，因此改开关不需要重启应用，也不影响已经跑起来的 PTY。关闭时
`--agents`、`--append-system-prompt` 与 `PreToolUse` 守栏一概不下发，会话就是一个原样的
Claude Code。`PostCompact` 与 `Stop` 两个运行时信号钩子不受开关影响：`Stop` 驱动
`pollTurnStopSignal` → `restoreEffortAfterCompatibilityTurn`，属于下文的 effort 400 兼容恢复
链路，与联网检索是两件事。以下描述的是开启后的行为。

`src/main/claude/web-research.ts` 为每次 Claude Code 启动提供一个
CLI-defined `claudedock-web-research` 子代理，经官方 `--agents` 传入，仅在该进程存活期间有效；
它 `model: inherit`、`effort: high`、`tools: [WebSearch, WebFetch]`，没有文件写入和再次委派能力。
`--append-system-prompt` 要求主线程在需要在线资料时先用 Agent 工具委派完整搜索任务，子代理只
返回带来源的检索结论，主线程再以用户原档位综合。这里不使用 `--agent`，因此不会替换 Claude
Code 默认系统提示；也不创建项目/用户级 agents 文件，不改变用户配置或 API 路由。

Windows PowerShell 5 在把参数对象重建为原生命令行时会移除未转义的 JSON 双引号；普通的
PowerShell 单引号只能保护 shell 解析，不能保证 `claude.exe` 最终收到的 argv。启动器因此对
`--agents` 使用专用编码：每个双引号前增加反斜杠，并按 Windows 原生 argv 规则把该引号前已有
的反斜杠成倍保留，再执行 PowerShell 单引号转义。这样 npm 安装产生的 `claude.ps1` 转发器和
直接安装的 `claude.exe` 都能收到可解析的完整 JSON；普通路径、模型和系统提示仍沿用原转义，
不会多出反斜杠。

只转义引号还不够。一旦参数里含有 `"`，PowerShell 5 就把这段字符串**原样**交给原生命令、
不再补自己的外层引号，于是 MSVCRT 的 argv 解析按空格拆分——实测下发的子代理定义会变成 75 个
参数，Claude Code 因此一直报 `Agent type 'claudedock-web-research' not found`。编码的最后一步
把 JSON 里剩余的字面空格换成 ` `：它是合法的 JSON 字符串转义，解析结果与原对象逐字节相同，
但参数里不再有可供拆分的空白。空格只会出现在 `JSON.stringify` 产生的字符串字面量内部
（输出无缩进），因此这步替换不会碰到结构字符。

这条链路是否出问题取决于具体载荷，所以 `tests/main/claude-configuration.test.ts` 的 argv 回归测试
直接使用实际下发的 `CLAUDEDOCK_WEB_RESEARCH_AGENTS`：此前那个自造载荷恰好能通过旧编码，测试
因此在缺陷存在时仍然是绿的。测试启动 argv 探针、重新解析 `--agents`，并断言 argv 中只有一个
参数包含代理名。验证不依赖每次新开对话手动发一条联网请求。

临时 settings 的 `PreToolUse` 只在联网检索隔离开启时写入，对 `WebSearch|WebFetch` 调用
`assets/runtime/claude-web-search-guard.ps1`。脚本解析 hook 的 `agent_type`：专用子代理内放行，
主线程直调返回 exit 2，并把“改用 `claudedock-web-research`”作为工具拒绝原因交给 Claude；hook
JSON 无法解析时 fail-open，避免脚本兼容问题把所有联网能力锁死。提示负责常规主动路由，guard
负责遗漏时的确定性守栏，两者都不尝试从 hook 内发送 `/effort`，因此没有 PTY 命令竞态。

Claude Code 仍可能在特定模型或网关组合中发送 `output_config.effort 'xhigh'/'max'`，却把
thinking 关闭。`parseClaudeEffortThinkingDisabledError` 只在最新一段 `API Error:` 同时含有
这两个条件时命中，并能跨 PTY 软换行识别；普通 401、404、连接失败或其他 400 均不进入兼容
恢复。命中后 `ClaudeEffortCompatibility` 记录被拒档位、检测时间与 `pending/recovered/failed`
状态，per-session 命令队列自动提交 `/effort high`，并记住错误前的请求档位。回退期间只开放
`low/medium/high`，renderer 提示重试；下一次顶层 `Stop` 信号到达后自动提交
`/effort <原档位>`、清除临时上限和旧错误。子代理完成产生的 Stop 带 `agent_id`，信号脚本会
忽略，不能在父任务仍处理搜索结果时提前恢复。恢复或换模型时同步清空旧 API Error 诊断片段，
避免后续普通终端输出把同一个 400 再次识别。换模型或重启 PTY 同样清除待恢复状态。

生效值与请求值必须分开存。模型不支持某档时会静默降级到它支持的最高档，`ultracode` 也只会
回报 `xhigh`，所以 `ClaudeMetrics.effortLevel`（状态行真值）优先，`ClaudeProjectState.effortRequest`
只在状态行还没刷新前顶一下；兼容恢复刚完成时则优先显示请求值 `high`，避免旧 metrics 继续
显示已失败的高档。`prepareLaunchInternal` 重启时清空 `effortRequest`，因为新 PTY 会重新读取
持久化的思考程度设置，`max` / `ultracode` 这类仅本次会话的请求不再成立。
`optionalEffortLevel` 只接受五个真实档位，`auto` 和 `ultracode` 不可能从状态行回来。

**一个重启机制，两个调用方。** 跨端点换模型和 `dontAsk` 都走 `ClaudeRuntime.relaunch()`：
可选 `/compact` → 可选 `applyConnectionHistory` → `prepareLaunch(..., 'continue', startMode)`
→ `workspace.restart` → 写入启动命令。`--continue` 恢复当前目录最近的会话，所以对话不丢；
压缩是为了切到上下文窗口更窄的模型时不溢出。

**每次 launch 独占自己的 runtime artifacts。** `ClaudeRuntime` 为每次准备分配
`userData/claude/runtime/<session-id>/launch-<runtime-token>-<launch-generation>/`，其中同时存放
`settings.json`、`metrics.json`、`signal.json` 与 `turn-stop.json`；statusLine 与 hooks 只指向该目录。
异步读取完成后必须再次核对 runtime instance、launch generation、精确 `ptyGeneration` 与路径，旧
launch 的慢磁盘读取不能消费替代会话的 compact/Stop 信号、覆盖 metrics 或清除新的 effort 恢复状态。
清理只保留当前和紧邻的前一次目录，其余过期 artifacts 有界回收。

**压缩与顶层响应完成靠 hook 通知。** launch-owned `settings.json` 的 `PostCompact` 与 `Stop`
都执行 `assets/runtime/claude-runtime-signal.ps1`，分别原子写同目录的 `signal.json` 和
`turn-stop.json`
（`$OutputPath.$PID.tmp` → `Move-Item -Force`），内容只有 `{event, signaledAt}`，不回写 hook 载荷。
Stop 载荷含 `agent_id` 时直接退出，保证只报告主线程完成。脚本吞掉所有异常：丢一个信号最多
保留临时 high 或让压缩等到超时，不能弄坏对话。主进程在已有的 1 秒 `pollMetrics` 循环里读取
两个文件，持续消费时间戳；只有晚于本次 thinking/effort 错误的顶层 Stop 才能触发档位恢复，
旧响应留下的 Stop 不会让临时 high 立即失效。PostCompact 仍有 120 秒非阻塞超时。Windows
PowerShell 写入的 UTF-8 BOM 在 JSON 解析前统一剥掉。

**`Shift+Tab` 不改按键行为。** xterm 本来就把 `Shift+Tab` 编码成 `ESC [Z` 发给 PTY，
`attachCustomKeyEventHandler` 没有拦它，所以终端里这个快捷键一直是通的，缺的只是状态栏
知道模式变了。唯一需要新增的是输入框：`<textarea>` 里 `Shift+Tab` 默认做焦点遍历，
所以 renderer 拦下它并转发同一段序列，让快捷键与焦点位置无关。

### 斜杠命令可视化

`src/shared/ui/cli-command-catalog.ts` 是主进程执行白名单、Claude/Codex 工作台和测试的共同事实来源。
Claude 基准含 101 个有效表项、展开别名后 120 个调用名；Codex 含 50 行、展开组合别名后 53 个
调用名。每项记录 runtime、命令/别名、语法、分类、来源、版本/平台/功能条件、风险与
`run` / `compose` 动作；完整快照写入 `docs/reference/cli-command-catalog.md`。动态 Skills、Plugins 和 MCP
命令不进入静态清单，界面引导用户查看 CLI 原生 `/` 列表。

Claude 只有无必填参数且风险允许的条目能进入 `ClaudeRuntime.runCommand`，仍经过参数 500 字符、
禁止换行、会话运行状态和 per-session 分段提交队列；清理、退出、外部操作或需要参数的条目只生成
输入骨架并按目录要求确认。Codex 全部为 `compose`，ClaudeDock 不自动向 TUI 发送。`/clear` 的二次
确认保留在渲染层；验证后的 Claude 命令不由 IPC handler 直接拼接 `\r` 写 PTY，而与换模型和压缩
共享“正文 → 40ms → 回车”的队列。

### PowerShell 键盘与剪贴板

- 提示词的主入口是输出区下方的 `<textarea>` 输入框，不是 xterm 画布。选它的全部理由是
  `Ctrl+A`、`Shift+←/→`、鼠标拖选、`Ctrl+Z` 与 IME 组合都由浏览器原生提供，**没有对应代码**，
  因此也没有「按键处理器模拟编辑器」引入的终端弊端。需要实现的只有三件事：
  `Enter` 发送 / `Shift+Enter` 换行、`↑/↓` 翻本地历史、自动增高。
  `↑/↓` 只在光标位于首/末且无选区时才翻历史，否则方向键属于文本编辑；
  `event.isComposing` 或 `keyCode === 229` 期间一律不拦截。
  历史存在 `localStorage['claudedock.composerHistory']`（最多 200 条，
  `src/shared/conversation/composer-history.ts`），只保存提示词文本，不保存终端输出。
- `src/shared/conversation/composer-input.ts` 的 `buildTerminalSubmission` 把多行内容用 `\x0a` 连接，
  单次上限 64,000 字符。`\x0a` 正是下面 `Ctrl+J`→`AddLine` 绑定所插入的字符，
  所以多行提示词进入 PowerShell 时是**一条**命令而不是逐行执行；这两处必须成对修改。
- 它返回的是 `{ body, submit }` 两段而不是一个字符串；共享的 `writeTerminalSubmission`
  间隔 `SUBMIT_DELAY_MS`（40ms）分两次写入 PTY，并在间隔两侧检查目标会话仍有效。renderer
  的提示词、主进程的模型切换、压缩和命令页动作都走这个物理写入约束。原因是 Claude Code
  的 TUI 会把一大块单次写入判定成括号粘贴，并吞掉贴在末尾的回车——内容落进它的输入框却
  不发送，用户看到的就是「点了发送没反应」。
  对 Claude Code 2.1.220 实测：200 字符的提示词以 `body + \r` 单块发送 0/3 提交成功，
  拆成两次写入 3/3 成功。PowerShell 两种写法都一样，多行仍是一条命令。
- 每个应用内 PowerShell 启动时把控制台输入、输出和管道编码设为无 BOM UTF-8，仅为该进程
  加载 PSReadLine，并把 `Ctrl+J` 绑定到 `AddLine`；renderer 将 `Shift+Enter` 转为 LF，
  因此多行输入不需要修改用户 profile 或外部终端。
- xterm 的键盘处理在自定义快捷键前放行 `isComposing`/keyCode 229，避免截断 Windows 中文
  输入法组合事件；Unicode 11 addon 负责 CJK 宽字符单元格计算。该 addon 使用 xterm 的
  提议 Unicode API，因此终端实例显式设置 `allowProposedApi: true`；当前只把它用于固定的
  Unicode 11 addon。renderer 不再依赖可能滞后的状态快照丢弃 `onData`，主进程 PTY 仍是
  最终写入边界。
- 输出区仍可直接聚焦打字，因为 Claude Code 自身的 TUI 需要原始按键（例如 `resume` 打开的
  方向键选择器，所以该操作之后焦点留在输出区而不是输入框）。输出区内的 `Ctrl+A` 映射到
  `terminal.selectAll()`——不映射的话它会被 PSReadLine 解释成「移到行首」，用户看到的就是
  「Ctrl+A 无法全选」。
- 会话内 Backspace 处理器检测光标前是否为 PSReadLine 多行换行符：是则删除该换行并回退
  光标，否则调用标准 `BackwardDeleteChar`。该绑定不会写入用户 profile。
- `TerminalStatus.size` 随每次 PTY generation 发布其已采纳的 `{ cols, rows }`；xterm 在 `open()` 和
  接收首个输出字节前就使用该网格，后台替换视图不能从默认 80×24 开始解析最大化终端的全屏输出。
  所有对话共用同一显示区域和字体，因此每帧只测量可见视图一次，再按各自 generation 同步前后台视图
  与 PTY。新增或后台 generation 替换也触发同步，不依赖用户改变窗口大小。`TerminalSession.resize()`
  夹紧并返回实际采纳尺寸；`terminal:size` 回声必须不早于当前 view 的最新 resizeRevision，旧回声不能
  将新网格缩回去。PSReadLine/CLI 的绝对光标重绘依赖两侧网格一致。
- xterm 有选区时 `Ctrl+C` 通过主进程 `clipboard` API 复制；无选区时仍发送控制字符中断。
  粘贴的物理路径固定为
  `clipboard → Terminal.paste once → xterm onData once → generation-fenced writeTerminal once`。
  剪贴板 helper 在读取前后都验证精确 `sessionId`、`ptyGeneration` 与 `TerminalView`，不得直接调用
  `writeTerminal`；`Terminal.paste()` 独占换行规范化和 bracketed-paste wrapper。只有不带 Shift、Alt、
  AltGraph、Meta 且非 repeat 的纯 `Ctrl+V` 被应用接管，并执行 `preventDefault`、`stopPropagation`、
  `stopImmediatePropagation` 后 `return false`。共享边界允许 5 MiB clipboard text 加 12 个 bracket wrapper
  code units 作为一次 PTY write，超过边界才拒绝，不能为绕过上限而切块。
- 终端容器在 capture 阶段拦截右键 `mousedown` 和 `contextmenu`，先于 xterm mouse tracking 与 Chromium
  default。菜单 target 固定为打开时的 session/view/generation/revision；自身 Paste 点击隐藏菜单不改变
  revision，另一个菜单打开则推进 revision，使前一个尚未完成的 clipboard read 在回写前失效。PTY 或 view
  stale 同样无输出；view disposal 会关闭菜单并移除 capture listeners。复制、全选和只清除 xterm 显示继续
  复用同一菜单。
- 会话未在运行时输入框禁用并更换 placeholder；启动会话、切项目等操作记录目标 session ID，
  renderer 只在该 session 仍为活动会话且 phase 已变为 `running` 后于下一绘制帧聚焦输入框。
  固定 40/60/80ms 延时已删除，避免 PTY 冷启动慢时焦点请求落在 disabled textarea 上后丢失。
- 控制栏与工作台宽度写入 renderer `localStorage`；这只保存像素宽度，不包含项目、命令或
  终端内容。活动栏维护 `selectedRailTab | undefined`：点击当前项切到 `undefined` 后把
  控制栏设为 `inert` / `aria-hidden`、把四列工作区压成“活动栏 + 终端”，并重新安排有限次
  xterm `fit()`；`mainView` 独立记录 `terminal/chat`，所以收起“对话”配置侧栏不会把聊天
  主区误切回终端；任一其他业务导航会恢复终端。`styles/07-responsive.css` 的 1024px medium 档只
  夹紧 rail/drawer；底栏由 `shell/footer/session-settings.ts` 比较 footer 可用宽度与 core、secondary、
  status 的自然宽度，在真实溢出时设置 `data-session-settings-overflow`。CSS 据此让“会话设置”按钮
  进入/退出并把同一 secondary DOM 转成弹层；disclosure 维护 `data-open` 与 `aria-expanded`。
  控制器还幂等管理方向键/Home/End、Escape、外部点击、失焦和焦点返回，同时把四个 owned option menu
  视为区域内部。720px compact 档收起项目栏和压缩导航；
  1280px wide 只用于允许更宽的信息布局。媒体查询常量及职责以 `design.md` 为准。

## 官方 AI 网络预检与访问守卫

### 两个独立 authority

`NetworkPreflightResult` 的当前 schema 为 version 2。它保留两个不能互相替代的嵌套结果：

- `providerConnectivity`：精确配置 Provider 目标的连接 authority。DNS、TLS、HTTP status/reachability、
  redirect trust、captive-portal/content-substitution、实际 Electron application session、CLI transport 和
  当前动作要求的 WebSocket 共同决定 `allowed`、`allowed_with_notice`、`partially_available`、`unknown` 或
  `blocked`。兼容顶层 `status` 只从该结果派生，不是第二个事实源。
- `advisoryEvidence`：目标限定的路径、公网地址、DNS、IPv6、STUN、接口、时区、语言、兼容性和信誉
  观察。它独立记录 collection state、severity 与 confidence；缺失或高风险建议项不改变一个已经通过的
  Provider 连接，也不能把失败的 Provider 端点改成可用。

`src/shared/router/provider-profiles.ts` 是版本化 Provider 配置源，集中维护官方 HTTPS/WSS 端点、动作需求、
缓存 TTL、CLI 版本规则、来源和检索日期。规则随应用发布，不运行时下载；schema 损坏、重复 endpoint ID
或不安全 URL 会 fail-closed。自定义 target 使用调用方保存并重新校验的精确 URL，绝不借用官方结果。

### 主进程数据流

1. `NetworkPreflightService` 在第一个 `await` 前冻结 Provider、action、normalized project、
   `NetworkPreflightTarget`、network scope 和稳定 proxy epoch。缓存/single-flight 身份包含这些字段；
   custom target、application/conversation scope 或 route epoch 不同即不能命中同一结果。
2. `NetworkPathResolver` 为每个实际 target 记录 `target`、`networkScope`、`process` 与 `proxyKind`。
   `Session.resolveProxy(url) === DIRECT` 只表示 Electron 没有为该 URL 返回显式 HTTP/SOCKS/PAC 代理；
   CLI 没有 proxy environment 也只说明进程可见配置。两者都不证明物理公网直连，也不排除 TUN、透明
   proxy、soft router 或 destination routing。
3. `ProviderConnectivityProbe` 对精确 Provider endpoint 执行 DNS A/AAAA、TLS、无凭据 HTTP、redirect 与
   content validation、实际 `Session.fetch` application transport、CLI HTTPS/TLS 和按 action 要求的
   WebSocket Upgrade。401/403/405 等典型未认证状态表示 endpoint 已响应，不表示登录成功。受信任同源/
   官方 redirect 可验证后接受；非白名单跨源、HTTP downgrade、TLS failure、portal/substitution 或必需
   transport failure 阻止对应动作。
4. Electron application probe 绑定真实 application/conversation Session，读取有限状态/headers 后停止
   body。预检先使用同 scope 的 `Session.fetch`，需要逐跳校验 redirect 时走受控 `ClientRequest` adapter。
   Electron 43 的上传 Writable 在 `end()` 后可能先 `finish → close`，URLLoader 随后才交付 redirect、
   response 和流式 body；当 `writableFinished` 为真时，上传 close 不代表请求失败，adapter 保留网络监听
   直到响应终态、真实 error/abort 或调用方 deadline。真实截断和取消仍失败，完成后移除监听并吸收可能
   迟到的 URLLoader error。CLI probe 使用即将启动业务的实际环境与 transport。
5. `RiskDecisionEngine` 只从 required Provider evidence 派生 `providerConnectivity` 与 `featureAccess`。
   `allowed_with_notice` 仍是绿色可用；TUN/virtual interface、显式代理、destination split、generic IP
   disagreement、reputation unavailable、language/time-zone 或本机 IPv6 状态都不能降级工作正常的 Provider。
   CLI 版本不兼容可以作为独立 launch compatibility gate，但不得伪装成 network-route failure。
6. `EnvironmentRiskProbe` 独立收集各项 advice；一个 observation endpoint 失败不跳过其余来源。
   `api.ipquery.io`、`myip.ipip.net`、`api6.ipify.org`、STUN、DNS comparison 和 reputation 都是各自
   observation endpoint 的 destination-scoped evidence；没有任何一项可以命名为“模型出口”“Claude 出口”
   或 Provider egress。STUN 只代表 WebRTC observation，不代表 Electron/CLI HTTP route。信誉源只有返回
   可用的 negative/positive 字段时才算已完成；来源不可用不能伪装成低风险通过。
7. 每条公网地址观察记录 process/session、transport、可知时的 address family、exact observation endpoint、
   collectedAt、freshness、confidence 与 source agreement，并附带“不证明 Anthropic/OpenAI endpoint 的
   public source address”边界；不可用来源不伪造 address family。完整地址只在 main 暂存；renderer/history
   最多收到规范化 IPv4 `/24` 或 IPv6 `/64` prefix 以及对应 provenance/confidence。IPv4/IPv6 分别得出
   collection state，不用一个地址族补全另一个。所有 environment check 还记录 advisory authority、process、
   network scope、target、transport/method、checkedAt、freshness 与 confidence；cache 命中和持久化历史投影
   标为 `cached`，不回写或篡改仍为 `live` 的内存结果。
8. 预检通过 `ApplicationProxyCoordinator` 的 reader lease 与 proxy/config writer FIFO 线性化。所有
   success/failure/cancel/cache/observability paths 在 `finally` 幂等释放 lease；每个 await 后都复核 main
   run ID、generation、target、epoch 与 lease currentness。stale result 不写缓存、不记 history、不通知、
   不授权业务。
9. `ProviderAccessGuard` 在 Codex login/launch、官方 Claude、受管 ChatGPT、official chat first request 和
   provider switch 等动作的 commit/PTy mutation 前读取 `providerConnectivity`。自定义 gateway 和本地
   terminal 只检查自身 target，不受其他官方 Provider 状态影响。`ClaudeLaunchHealthMonitor` 同样保留
   `allowed_with_notice`，显示绿色“连接正常”并把 path/advice 放在 secondary copy。
   自动新会话/登录检查使用 `fresh`：跳过已完成缓存，但相同身份的并发请求共享正在执行的检测，每个
   等待者仍持有自己的取消信号和 route lease。只有显式“重新检测”的 `force` 才取代旧检测；代理 epoch
   或目标变化仍使旧证据失效。不能把“需要新鲜证据”实现为取消同项目其他会话的自动预检。
   Chromium `navigator.connection.change` 的 RTT、downlink、effectiveType 估计变化不作废证据；探测本身
   也可能改变这些估计。只有已知 transport type 变化、online/offline 与主进程权威配置变化才走相应
   失效路径，避免一批新建/恢复对话互相取消。
10. 首次阻止若仅来自 DNS、reset、connect failure 或 timeout，且仍有 active IP path，可等待 150ms 后
    fresh 一次新 probe，并与同身份的其他重试共享进行中的检测；offline、TLS、untrusted redirect、portal、unsupported CLI transport 和 internal
    failure 不自动重试。等待和第二次 probe 共用调用方 AbortSignal，取消后不得继续业务操作。

### 操作授权与事务边界

- launch 阻止结果冻结 session/project、Provider、exact target、configuration revision、launch generation
  与 predecessor PTY generation。renderer 只能取消、force recheck 或一次性坚持连接；main 在消费前重验
  全部 identity，授权不能跨项目、跨 route、跨 provider 或重复使用。启动后的 health monitor 只有状态
  发布能力，不主动 stop/restart/close 已运行会话。
- `SessionConfigTransactionCoordinator` 按实际配置 scope 串行 profile 事务。每个 conversation profile 使用
  独立协调器的 scope key，不获取项目目录隔离，也不取消兄弟启动；旧版共享项目 profile 仍使用目录
  barrier。访问守卫先于无 `await` 的 profile commit/PTy mutation；rollback 只有在事务仍拥有 scope、
  session、原项目和精确 committed snapshot 时才能恢复，不覆盖兄弟会话或外部更新。预检失败不把仍运行
  的 Claude/Codex 错标 inactive。
- WebSocket 401/403/426 只证明 Upgrade endpoint 响应。可选 WebSocket 不改变普通 login/background
  结论；只有当前 action 明确 require 时，失败或 unknown 才进入 `partially_available`/`blocked`。
- 本实现不修改 Windows system proxy、DNS、route table、NIC、time zone/language、Claude/Codex settings
  或登录存储，也不自动关闭 VPN。显式 CLI `TZ` override 只作用于之后由 ClaudeDock 启动的子进程。

### 路径、建议与历史边界

- UI 的 provider conclusion 始终先于 advisory。之后依次显示 exact endpoint evidence、application/CLI
  visible proxy decision 与 TUN caveat、endpoint-scoped public-address observations，再显示 DNS、IPv6、
  STUN、interface、environment、compatibility、reputation 与建议操作。
- DNS server list 只代表本机配置；random authoritative DNS comparison 只描述该测试 target 观察到的
  resolver。国家/网络不一致、来源冲突或 unavailable 是 advice，不证明 Provider route 泄露，也不阻止
  已通过的 Provider。generic public-IP destinations 之间的一致或不一致同样不产生 direct-route mismatch。
- 外部应用代理只把用户填写的 HTTP/SOCKS5 参数传给勾选 scope，不提供远程网络服务；路径证据不记录
  proxy credential、完整 URL query 或授权字段。
- `NetworkDiagnosticsStore` version 2 持久化嵌套 `providerConnectivity` 与 `advisoryEvidence`，不写含糊的
  flat duplicate。version-1 记录迁移为明确 `legacyComposite`，连接 authority 为 unknown；旧综合字段不会
  被展示成新 schema 的 Provider evidence。历史保留 7 天、最多 40 条，写盘前再次移除 Bearer、`sk-*`、
  URL credential/query、完整 public IP、cwd、request/response body、OAuth token、API key 与 proxy secret。
- `userData/network-preflight/history.json` 使用 `0600` intent、同目录临时文件和 atomic rename。诊断写入、
  notification 或 reputation adapter 失败属于 observability/advisory failure，不能改写已经得到的 Provider
  result。用户可从详情清空历史。

### 维护与外部依据（核对日期 2026-08-22）

- OpenAI ChatGPT/Codex 网络与 WebSocket 端点：
  <https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps>
- OpenAI Codex 登录、退出与本地凭据缓存：
  <https://learn.chatgpt.com/docs/auth>
- IPQuery API 与风险字段：
  <https://github.com/ipqwery>
- ProxyCheck IP 风险接口：<https://proxycheck.io/api>
- Stop Forum Spam IP 公开滥用记录：<https://www.stopforumspam.com/usage>
- dnscheck.tools 权威 DNS 测试方法与源码入口：<https://dnscheck.tools/help>
- 分流出口采集方法参考：<https://github.com/stormzhang/ipcheck>
- xAI API 与 Grok Build 官方网络要求：<https://docs.x.ai/developers/quickstart>、
  <https://docs.x.ai/build/enterprise>
- Node.js `TZ` 环境变量（Windows 支持）：
  <https://nodejs.org/api/cli.html#tz>
- Claude Code 企业代理、CA 与必需域名：
  <https://code.claude.com/docs/en/network-config>
- Claude Code 官方安全公告：<https://github.com/anthropics/claude-code/security/advisories>
- Electron `Session.fetch` 与 Chromium 网络栈：
  <https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init>
- Electron `net.fetch` manual redirect 限制：
  <https://github.com/electron/electron/issues/43715>
- Electron Chromium 网络栈与系统代理能力：<https://www.electronjs.org/docs/latest/api/net>
  维护服务商规则时必须同步更新 `updatedAt` / `sources[].retrievedAt`、相关测试和本节。版本阻断规则
  必须有可追溯的官方安全公告，不能把媒体信息伪装成官方产品政策。

## 安全策略

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 主页面 CSP 只允许本地脚本、样式、字体，图片允许本地、`data:` 与 `https:`；Markdown 远程图片
  内联渲染，带 `referrerpolicy="no-referrer"`。frame 只允许 `claudedock-artifact:`，开发模式额外
  允许本机 Vite 连接。Artifact 使用独立响应 CSP。
- 禁止任意页面跳转、弹窗和未授权 IPC 通道；`validateSender` 同时要求目标
  `webContents` 与 `senderFrame === mainFrame`，sandbox 子 frame 不能调用 preload IPC。
- 不保存终端输入或命令历史；项目直连密钥与 Router 客户端密钥只以 Windows `safeStorage`
  密文持久化，OpenAI 上游密钥交给本机 CCR Provider 存储；为支持启动时绑定实际当前 API 和历史完整
  恢复，用户本次新填的上游密钥还会分别以 `safeStorage` 密文进入项目 profile 与历史，renderer 始终
  只接收“是否已配置”的布尔值和短指纹。
  终端不会收到含密钥的文本命令。对话连接绑定需要的 API 凭据同样只保存为 `safeStorage` 密文；磁盘
  上的指纹不可反推出凭据，完整摘要也不跨 main/preload 边界。PowerShell 自身行为不在应用持久化范围内。
- 原生 `node-pty` 只在主进程加载；`node-pty` 与需要由外部 PowerShell 执行的
  `assets/runtime/claude-statusline.ps1`、`assets/runtime/claude-runtime-signal.ps1`
  均在打包时从 ASAR 解包。
- 「完全允许」有两道入口限制：项目级开关必须开启，且只有启动时预置过该标志的会话才能切进去。
  这是 Claude Code 自己的限制，客户端无法绕过。首次以该标志启动时 Claude Code 会显示自己的
  一次性确认框，ClaudeDock 不代答。

## 技术约束

- **不解析任一方的会话 JSONL。** Anthropic 说明 “The entry format is internal to Claude Code
  and changes between versions”；Codex 的 rollout JSONL 无公开 schema。跨引擎迁移只走官方通道
  （Claude Code `/import codex` 覆盖配置；Codex 侧 app-server `externalAgentConfig/import`
  覆盖会话，单向）。跨供应商的推理链与 prompt cache 必然丢失，切换开发引擎时不向用户承诺
  对话连续性。<https://code.claude.com/docs/en/sessions>
- **`AGENTS.md` 不被 Claude Code 读取**（`anthropics/claude-code#6235` 自 2025-08 开启至今无
  维护者回应，5,916 反应）。Windows 上建符号链接需管理员权限或开发者模式，因此若将来需要共享
  指令文件，正解是 `CLAUDE.md` 内写 `@AGENTS.md` 导入行。
  <https://code.claude.com/docs/en/memory>
- **`~/.codex/config.toml` 的 `project_doc_fallback_filenames` 必须是顶层键**，放进 `[project]`
  表会静默失效（OpenAI 维护者在 `openai/codex#22454` 确认）。当前 `mcp-manager.ts` 只读该文件，
  不受影响。
- **Codex OAuth 凭据由官方 Codex 实现保管。** 项目不读写 `~/.codex/auth.json`（见「App Server
  登录边界」）。

## 构建、测试与调试

命令清单、适用范围和通过标准以 [verify.md](../how-to/verify.md) 为唯一事实源：快门禁包含 lint、
format、三套 typecheck、全量 Vitest、dependency-cruiser 与 build；跨进程、结构或构建改动还执行全部
Electron/ConPTY/soak 门禁和三项 opt-in Windows 集成测试。最终候选的门禁发生在全部发行改动提交后的
exact commit。定向清理旧生成物后，`npm run release` 从 clean source 与空 `outputs/` 开始，依次执行
`npm ci`、质量门禁、`npm run dist`、源码身份复核和 manifest，生成
`outputs/release-manifest.json`。COS 发布是后续独立的 `npm run release:publish:cos`，不会由构建或 CI
隐式触发。测试数量取自 exact-commit 日志；安装包路径、版本、通道、feed、各产物大小与
SHA-256/SHA-512、cohort、公开 COS 长度/Range/缓存验证及 Authenticode 状态取自最终 manifest 和远端
验收。签名语言必须以最终候选状态为条件；`NotSigned` 候选不得称为正式签名发行版。

- `npm run dev`：并行运行 main `tsc --watch`、preload Vite watch、renderer Vite server，并在 main/preload
  产物和本机 Vite 端口就绪后启动 Electron。
- Vitest 在默认排除项之外固定忽略 `**/.claude/worktrees/**`；Claude CLI 留在仓库内的辅助工作树
  可能包含同名旧测试，但它们不是当前提交的测试事实来源，不能让本机残留副本污染门禁结果。
- `npm run lint`：检查 TypeScript 源码。
- `npm run typecheck`：分别检查渲染端与测试、主进程、preload 三套 tsconfig。
- Windows 公共命令的取消清理总预算为 5 秒。根包装进程已退出时，CIM 只查询 PID、父 PID 和创建时间，
  并可使用剩余的完整清理预算；仍存活的根进程使用最多 3 秒的 taskkill。根进程在初次判断后退出时，
  使用剩余预算补做后代清理。创建时间复核与 PID 边界保持不变。
  进程流测试同时验证后代退出、清理返回码与未超时状态，失败时附带清理诊断。
- `npm test`：运行目录/工作区、项目级开发引擎持久化、Codex 官方 Release 元数据与
  SHA-256 约束、账号/额度响应白名单、沙箱启动命令、Claude 配置与版本门禁、cURL 协议识别、Router 配置
  定向修改与秘密净化、官方安装包元数据校验、运行期 API 错误识别与路由阻断、高档 thinking
  环境清理、跨行 400 识别、WebSearch 高档子代理隔离、顶层 Stop 后原档位恢复、连接测试
  结果映射、工作区持久化、当前项目会话解析与删除边界，并在 Windows PowerShell 中用模拟
  statusLine JSON 验证指标采集脚本；同时覆盖插件目录合并、输入校验、会话标题优先级与
  `custom-title` 写入、自动标题同步与手动重命名竞态、目录选择器默认路径回退、终端主题约束、
  PowerShell 启动脚本语法和软件语义版本比较；独立对话测试额外覆盖凭据密文落盘、URL
  安全边界、未保存草稿连接测试、DeepSeek thinking-only 协议 envelope、credential keep/clear、
  Token 估算、多模态协议线格式、
  typed thinking/refusal/retrying、Anthropic/OpenAI 两类 SSE usage、瞬时 HTTP/网络重试、
  严格结束标记、部分输出不重放、重定向安全与兼容回退、附件原子导入/
  UUID 引用/裁剪回收、1.x 历史迁移，以及 Markdown XSS、链接、公式、Shiki、Artifact opt-in
  和流式稳定前缀。
- `tests/main/runtime-activity-registry.test.ts` 覆盖后台任务/子代理的 waiting→resuming→stop/failure 状态机
  与代次隔离；`tests/main/claude-permission-bridge.test.ts` 在 Windows named pipe 上验证排队、允许、拒绝、
  超时/代次失效回退；`tests/main/runtime-process-registry.test.ts` 覆盖进程树、TCP 监听、PID 创建时间复用、
  不透明键、禁终止程序和温和/强制清理；`tests/main/claude-stream-diagnostics-store.test.ts` 锁定脱敏分类与
  14 天/200 条/2 MiB 裁剪。`tests/shared/cli-command-catalog.test.ts` 锁定 101/120 与 50/53 的完整调用集合。
- `tests/main/claude-agent-adapter.test.ts` 还模拟完全不带 UUID 的逐 token stream，断言全部 delta 与最终
  assistant 帧只产生一个完成消息；renderer 源码守栏同时锁定消息节点复用、每帧快照合并、流式纯文本
  与完成后 Markdown 的边界，以及用户气泡/助手终端壳的主题化结构。
- `npm run test:runtime-soak:accelerated` 在数秒内模拟 24 小时的 1,440 个 Hook 事件和 57 次本地 Web
  进程创建/回收；`npm run test:runtime-soak` 运行真实 24 小时的同类无付费模型合成测试。它们验证
  ClaudeDock 自身有界状态与回收路径，不承诺上游模型或网关连续 24 小时无故障。
- 4.0 守栏覆盖 BusyRegistry 租约释放、下载 EMA/ETA/恢复日志/来源与完整性、退出和托盘忙态、
  外部应用代理 DPAPI 存储/作用域/候选解析、移除旧代理 IPC、应用双更新源信任与测速选择、
  供应商能力矩阵、CCR CLI-only、
  CC Switch MSI/深链/清理牢笼、MCP 三作用域发现/diff/备份/逐字节还原，以及对话无总时长上限、
  静默探活和可选 `local-timeout`。`tests/main/cli-only-guard.test.ts` 与
  `tests/main/chat-timeout.test.ts` 作为跨模块源码不变量，避免未来调用点绕过局部单测。
- `tests/main/managed-chatgpt-gateway.test.ts` 锁定 CLIProxyAPI 最新发行元数据的仓库/tag/资产名/大小/
  SHA-256 验证、ZIP 路径穿越拒绝，以及仅监听回环地址、关闭远程管理和使用独立认证目录的配置；
  同时验证网关进程净室删除继承的供应商路由/凭据变量但保留 HTTP 传输代理。授权事务测试覆盖普通读取
  在 pending 期间失败关闭、当前 setup 只接受精确拥有的唯一 active 事务，以及登录、启动、模型发现
  完成后才提交的新授权闭环。账号退出只停止受管进程、
  清除该独立目录内的授权文件并移除本地授权状态，不调用登录程序、不打开浏览器，也不触碰浏览器 Cookie
  或 Google 登录。renderer/main 源码
  守栏要求受管状态 IPC、OpenAI 官方浏览器授权文案、一键安装入口，以及“旧 PTY 先停、成功后在
  新路由恢复、失败不回落”的切换顺序保持存在。
- `tests/main/model-speed-capabilities.test.ts` 锁定 Claude/GPT 支持矩阵、最低 Claude Code/CLIProxyAPI
  版本、未知模型和第三方路由的 fail-closed 分类；`tests/main/model-speed-preferences-store.test.ts` 覆盖
  默认标准、按目标隔离、原子裁剪、损坏文件回退和磁盘中不得出现凭据；
  `tests/main/claude-configuration.test.ts` 与 `tests/main/claude-statusline.test.ts` 继续验证三种速度 profile、
  `CLAUDE_CODE_EXTRA_BODY` 清理以及 `fast_mode` 严格布尔解析。
- `tests/renderer/claude-launch-attempt.test.ts` 覆盖 per-session generation、冷状态 baseline、conversation/PID/
  `ptyGeneration`/active→inactive 释放路径、同 PID 新 PTY、显式失败、terminal failure、session 删除、
  tombstone 裁剪，以及确认挂起或 IPC 迟到时被删除/失效/替代的 executable interleaving；
  `tests/main/session-operation-coordinator.test.ts` 验证被取消 lease 在 callback unwind 前仍独占，
  `invalidateAndWait()` 等待完成且不同 session 可并行；`tests/main/session-operation-integration.test.ts`
  固化 main 进程真实 stopped/error 转换、Codex/受管切换租约、runtime switch 检查与延迟命令 ownership。
- `tests/main/terminal-workspace.test.ts` 以可替换假 PTY 执行 stale write/resize/stop/data 拒绝，并锁定 restart
  generation 只递增一次、stop 不递增；`tests/main/terminal-session-generation.test.ts` mock 真实 node-pty spawn，
  在 G2 已运行后触发 G1 的迟到 data/exit callback，验证生产 `TerminalSession` 的进程对象与 generation
  双重围栏，并覆盖 spawn 失败、stop 与再次 start 的递增语义；`tests/main/terminal-lifecycle.test.ts` 用延迟
  Promise 执行 start/restart/stop 的七步顺序、入口 stale、unwind 期间替代和失败 cleanup ownership；
  `tests/main/terminal-output-batcher.test.ts` 执行 generation 替换、迟到数据、手动触发已取消 timer、scoped
  discard、live-generation flush 与 dispose。`tests/main/claude-runtime-pty.test.ts`、`tests/main/codex-runtime.test.ts`
  验证精确绑定、
  冲突重绑、旧输出/退出标记/cleanup 失效，以及 PTY 替换发生在正文与延迟回车之间时不会把回车写进
  新 shell。renderer 源码守栏还要求 TerminalView、RAF 缓冲、xterm write queue、resize 与 permission
  probe 全部携带 generation。
- `tests/renderer/renderer-html.test.ts` 使用 Prettier 的严格 HTML 解析器检查渲染入口，同时验证 ID
  唯一性和 `requiredElement` 启动依赖，防止浏览器容错解析掩盖 UI 结构损坏。
- `tests/renderer/ui-localization.test.ts` 锁定 Unicode 11 所需的 `allowProposedApi` 设置，并防止已
  汉化的终端、接入与插件文案回退为英文或重新出现“英文原文”面板。
- `tests/renderer/design-tokens.test.ts` 遍历 `src/renderer/styles/**`，验证入口 import、未定义变量、三层令牌、
  六级字体角色、selector 唯一所有权、keyframes / viewport media / reduced-motion 文件职责，以及
  `SHELL_CSS_VARIABLES` 的默认值与消费者；同时按 WCAG 相对亮度校验四套主题的正文、强调色和
  语义状态色对比度。具体视觉规则只在 `design.md` 维护。
- `tests/shared/composer-input.test.ts` / `tests/shared/composer-history.test.ts` 覆盖输入框的两个纯模块：
  多行提交必须是 `\x0a` 连接的 `body` 加上单独的 `\r` `submit` 两段，历史的去重、上限与
  游标行为；提交测试还用假时钟验证两次 PTY 写入的顺序，以及会话在 40ms 间隔内失效时不会
  发送迟到的回车。
- `tests/renderer/lifecycle.test.ts` 与 `tests/renderer/` 的其他行为测试固化渲染层交互生命周期：分隔条必须显式释放捕获并覆盖
  失焦/隐藏，活动 xterm 必须可见后初始化并跨帧适配，输入框必须等待 `running`，左栏交互页
  的进场动画不得使用 `transform`；原生 `alert` / `confirm` 不得重新进入 renderer，统一
  确认框必须是可取消的应用内 `<dialog>`，窗口 focus/visibility 恢复路径必须重新读取工作区；
  活动终端的 `focus-within` 必须有主题色聚焦反馈；连接实测必须显示后台状态、在唯一
  `finally` 恢复测试按钮并让定时轮询避让；统一刷新必须在首屏后异步启动，三类更新入口默认
  隐藏，用户主动检查必须打开含空状态、逐项操作和全部更新的结果对话框；服务商反选、按上次选择单组展开、
  1/2/3 列容器查询、全局设置分类与接入快照式取消、独立聊天导航顺序、实时草稿 Token、
  连接测试、历史保存/恢复/删除入口、Claude/Telegram 主题外观和禁止 hover 上浮，
  以及活动栏二次点击收起也作为源码/结构契约锁定。终端提示词上方不得重新出现模式、模型或思考
  控制条，这些入口只能由底栏和命令页承载。底栏交互同样在这里锁定：连接按钮必须
  用保存配置原地测试、不得跳转
  “接入”页；当前 Claude 项目首次载入及窗口从托盘恢复时必须各自动实测一次，同一显示周期
  按 session 去重，普通 focus/visibility 不得重复消耗 token；忙态分支必须排在健康色分支
  之前（否则陈旧的路由健康会盖掉刚点下去的进度）；
  模型/速度/模式菜单必须挂在同一套 `pointerdown` + `blur` 收拢逻辑上并按响应式层级隐藏，六种
  权限模式必须全部出现在目录里；Claude 启动 generation 必须在首个 `await` 前建立并捕获
  `ptyGeneration`，冷状态用 `hydrateClaude` 建 baseline，launch/relaunch/速度切换必须共用 exact-token
  orchestrator，迟到确认或 IPC 结果不能释放、toast 或改写新 generation；模型切换的 `disabled` /
  `aria-busy` 必须在 `finally` 中
  直接恢复，`dontAsk` 与跨端点模型必须走同一个重启函数，输入框的
  `Shift+Tab` 必须转发 CBT 序列，而模式回读必须发生在 xterm 应用屏幕差量之后；主动 probe
  还要受输出修订号屏障保护并扫描完整活动缓冲区，不能在仍有待写数据时回复旧快照。
  独立对话契约还锁定活动栏点击后的下一帧聚焦、焦点请求的禁用/模态边界、四主题强调色焦点
  动画、历史区占满侧栏并独立滚动，以及详情抽屉禁止网格拉伸的紧凑分区结构。交互反馈地板也
  在这里锁定：`.terminal-composer` 与 `.chat-composer` 的聚焦规则必须是同一条（不得再出现
  只服务对话的 `chatComposerFocusIn`），每个按钮都必须有按压响应，且任何 `scale(var(--…))`
  引用的令牌都必须真实存在——`.chat-settings-trigger` 曾引用不存在的 `--press-scale`，按压
  静默失效。同一文件还锁定 MCP 面板的两处外观契约：`.mcp-toolbar > button` 必须落在共享
  tint 按钮族的底色、过渡与悬停三条规则里（「全部刷新」正是漏掉后退回 Chromium 原生外观的
  那个），`.dialog-primary` 必须自带底色而不是只靠弹窗内的作用域规则上色；以及卡片入场只能
  由 `data-fresh` 驱动，`renderMcpCatalog` 必须比对上一次渲染的服务器键集合。
- `tests/main/quit-confirmation.test.ts` 固化退出握手的每一个逃生口：`before-quit` 必须在执行
  teardown 之前把未置闩的退出退回 `requestQuit()`；`canAsk` 健康检查、二次请求强制通过和
  单实例锁失败必须无条件退出；`session-end` 必须直接置闩不发问；`app:confirm-quit` 只在
  收到 `true` 时退出且两种回答都清除 pending；托盘退出必须走同一函数而不是内联 `app.quit()`；
  可应答窗口不能因租约为空绕过确认，`starting/running` 会话必须合成为退出清单；桥接的两个方向
  都必须在契约里声明。
- `tests/main/claude-configuration.test.ts` 覆盖启动命令的权限参数（`--permission-mode` 的引号、
  `--allow-dangerously-skip-permissions` 只在未直接以 bypass 启动时附加、关闭后两者都不出现）
  与共享 `parseClaudePermissionMode` 的六种徽标、夹带 ANSI/OSC、徽标内部被着色打断、软换行
  拆开、同一快照多次出现时取最后一次，以及未绘制徽标时返回 `undefined`；同时覆盖只有
  显式凭据 + `prefer-claudedock` 才停用继承的 `apiKeyHelper`，以及中转站基址按发布形态原样
  存下（`/v1`、`/relay/v1`、`/proxy/anthropic` 都不被抹掉）；同时锁定会话级 `--agents`、
  `--append-system-prompt` 与 WebSearch guard 命令的 PowerShell 引号，反过来也断言联网检索
  隔离关闭时这三样都不出现、命令仍是一个原样的 `& claude`，并在 Windows 上把完整
  启动命令交给真实 `powershell.exe` 和 argv 探针，确认包含反斜杠与嵌套引号的 agents JSON
  到达原生进程后仍可解析且内容不变。这条 Windows 用例按载荷参数化，第一组就是实际下发的
  `CLAUDEDOCK_WEB_RESEARCH_AGENTS`：旧的自造夹具恰好躲过了 PowerShell 5 的拆分，而真实定义
  会被切成 75 段，因此除了 JSON 往返还断言 argv 里只出现一个含 `claudedock-web-research`
  的条目。
- `tests/main/advanced-settings-store.test.ts` 锁定中转站兼容项默认关闭、两项网络自动检测默认开启、
  version 1 迁移、version 2 往返持久化、非法布尔值/时区/语言被拒，以及损坏文件回落默认值。
- `tests/shared/connection-endpoint.test.ts` 分开覆盖两条路径：`completeConnectionEndpoint` 补出完整
  请求地址，`normalizeConnectionBaseUrl` 保留中转站发布的基址路径、只把整段 `/v1/messages`
  还原回基址、把粘进来的 OpenAI 端点指向协议开关，两者共用同一套不安全输入拒绝规则。
- `tests/main/claude-runtime-diagnostics.test.ts` 额外按 PTY 分块喂入徽标（跨 chunk 边界、
  4,000 字符滚动缓冲已经把旧徽标挤出去的情况），并用真实形状的光标差量确认残片不会被误当
  完整徽标；闭环源码契约还覆盖官方真实连接测试先经过访问守卫、隐藏窗口恢复事件只从
  main 经 preload 受限转发，以及首次按键前主动取样、单步失败即停止、已访问模式绕环检测、
  xterm 双向 probe 回报入口、per-session 互斥锁、切不到时报明确文案、`dontAsk` 与未预置的
  `bypassPermissions` 一律拒绝、模型选项在主进程重新核对、模型/压缩/命令页不再拼接尾随
  回车而是进入 per-session 提交队列、PostCompact/顶层 Stop 信号只在已有 metrics 轮询里读且
  只认未消费时间戳，以及 WebSearch/WebFetch 必须绑定专用 high 子代理。
- `tests/main/claude-config-store.test.ts` 覆盖 `allowBypassPermissions` 与 `apiKeyHelperPolicy`
  的持久化：权限默认开启、认证来源默认 ClaudeDock 单一凭据、单独写入不动凭据、保存接入
  配置不会静默重置、没有配置过路由的项目也能记住、重开 store 后仍在且 Windows 路径
  大小写不敏感。
- `tests/main/claude-runtime-signal.test.ts` 真实 spawn `claude-runtime-signal.ps1`：能在 stdin
  有 hook 载荷时正常写出 `{event, signaledAt}`、载荷内容不泄漏进文件、目录不存在时自建、
  再次触发时时间戳前进（否则主进程会把旧信号当成新信号）、成功后不留 `.tmp`，并确认
  顶层 Stop 会写信号而带 `agent_id` 的子代理 Stop 被忽略。
- `tests/main/claude-web-research.test.ts` 锁定搜索子代理继承当前模型、固定 high、只开放
  WebSearch/WebFetch，以及主线程委派规则不改变原 effort；
  `tests/main/claude-web-search-guard.test.ts` 真实 spawn PowerShell guard，验证主线程直搜被拒、专用
  子代理放行和畸形 hook JSON fail-open。
- `tests/main/claude-statusline.test.ts` 真实 spawn `powershell.exe` 验证状态行 JSON；Windows runner
  首次冷启动/安全扫描可超过 10 秒，因此每个子进程使用 30 秒硬超时、测试使用 45 秒上限，
  既容纳冷启动又防止脚本挂死拖住 CI。
- `tests/shared/update-actions.test.ts` 覆盖更新入口状态机：首次未检查、软件未安装、已是最新版和
  软件/插件混合更新四类状态不能互相误显。
- `tests/main/download-contracts.test.ts` 锁定下载 IPC（列表、命令、历史清理与变更订阅）跨进程连通、
  每个改动前都校验发送方与任务 ID、CCR 与 Codex 都走共享的校验下载内核，以及下载中心的
  进度呈现：不确定态只属于仍在推进的任务，`cancelled` / `completed` / `failed` 必须立刻停下
  转圈动画——`percent` 在服务端没给长度时一直是 `-1`，只看这个数字会让失败的下载永远转下去。
- `tests/main/download-history.test.ts` 覆盖终态历史的持久化、倒序、100 条上限、逐条删除、全部清空、
  损坏文件降级和敏感字段缺席；非终态任务不能进入历史，清理元数据不得删除最终下载文件。
- `tests/main/async-refresh-cache.test.ts` 与 `tests/main/background-task-coordinator.test.ts` 覆盖
  同键合并、TTL、失败重试、旧请求不覆盖新状态、两个并发槽和交互任务优先级；
  `tests/main/claude-connection-test.test.ts` 额外锁定响应体 64 KiB 读取上限与 owner cancellation 原样传播；
  `tests/renderer/connection-history-dialog.test.ts` 覆盖未选择取消、选中反馈、分类清空、确认后专用接入页、
  成功延时回落、失败重试、后台确认取消，以及加载、应用、删除、重命名跨项目后的迟到结果隔离；
  `tests/renderer/current-connection-summary.test.ts` 与 `current-connection-view.test.ts` 锁定账号、模型、中转
  名称/地址优先级、URL 敏感字段净化和 ChatGPT 账号的 generation + session fence。
- `tests/main/claude-official-auth-status.test.ts` 锁定 Claude 状态命令参数、Provider 环境清理、缓存、输出白名单
  和失败降级；`tests/main/claude-runtime-router-rollback.test.ts` 覆盖 Router 保存后取消与启动失败的精确补偿，
  配置事务测试同时覆盖项目快照回滚、较新写入保护和 session 跨项目后的目标 fence。
- `tests/main/claude-connection-history.test.ts` 用可逆的假 `safeStorage` 替身覆盖接入历史：
  重复保存不新增、任一字段（含凭据、helper 策略和协议）变化就新增、只有网关状态变化不新增、
  重放一条较早的记录把它移回最前面而不是新增一条、留空的小型/备用模型在回放时不被当成改动、
  version 1 记录迁移为安全策略与可解释协议、OpenAI 原始上游字段与 Router ID 可回放、重命名校验与持久化、
  明文密钥不得出现在磁盘文件里、恢复出的配置可直接用于保存、删除后再恢复报「已被删除」、
  Windows 路径大小写不敏感、条数上限、文件损坏后回落到空列表。
- `tests/main/conversation-preferences-store.test.ts` 与 `conversation-model-binding.test.ts` 覆盖 version 1
  迁移、绑定密文、无明文密钥、凭据/账户/路由/主模型/小型模型差异，以及“空白小型模型等于主模型”
  的规范化；`session-history-filter.test.ts` 锁定终端与原生 owner 都不会重复出现在历史区。
- `tests/renderer/workspace-shell.test.ts` 驱动真实 renderer 模块，覆盖模糊背景模型选择框、完整双方信息、
  不再提示持久化、原接入/当前接入动作，以及仅国外接入显示网络检查的左侧启动进度文案。
- `tests/main/claude-providers.test.ts` 锁定目录 ID 唯一、分组完整、远程 HTTPS/本机 HTTP 边界、
  模型字符规则、外链可解析、上次官方/国内/自定义选择只展开对应组及
  Kimi/SiliconFlow/Ollama 特例；
  `tests/shared/claude-connection-remedy.test.ts` 覆盖认证、路径、模型、环境和 Router 修复动作。
- `npm run test:layout` 使用隐藏 Electron 窗口在 720×640、820×640、900×640、1024×640、
  1180×760、1280×760 六种尺寸轮换项目/对话/接入、分类接入历史弹窗、插件的已安装/可安装/市场
  三个面板、工作台三页、收起控制栏和全局设置两个分类，并加入完整模型差异弹窗、富文本长内容、
  附件与 Artifact 抽屉压力态；模型弹窗分别检查滚动顶端与底部操作区，共 114 个场景；检查交互控件
  矩形相交、`elementFromPoint` 命中对象、关键容器
  横向溢出和文档级 overflow。扫描会识别滚动裁剪祖先，避免把模态内容区外不可见的控件误判
  为覆盖固定底栏；同一自绘 select 的原生层/视觉层、遮罩层与抽屉的有意叠放不计为控件重叠，
  且故意叠放的独立按钮校准探针必须先被检测到。此外单独断言输入框不被底栏或
  已打开的工作台抽屉覆盖——两者都不是可聚焦控件，通用相交扫描发现不了。插件页额外注入
  超长插件名、市场名、仓库 URL 与多按钮操作区，把内容最小宽度导致的遮挡变成 820px 下的
  可复现失败；独立对话额外注入超长模型名、128K Token 数值与长标题历史，覆盖新增状态。收起
  控制栏场景在测试窗口内同步关闭过渡后检查最终几何，避免隐藏 CI 窗口节流 CSS transition 时把
  中间帧误报为遮挡；这不会修改应用运行时样式。
- `npm run test:visual` 保留插件、服务商向导、内联历史配置、四主题分类历史弹窗及其选中态、四主题
  完整模型差异弹窗与 720px 单列态、四主题历史接入失败结果页、820px 单列态、
  全局设置、连接测试、终端聚焦态、
  Codex 三步工作台、代理/路由设置页与 MCP 管理页，
  独立对话详情抽屉与重命名弹窗回归图，并生成四主题 × 富文本对话/终端/终端遮罩的 12 张矩阵
  PNG，以及四主题 MCP、代理和路由截图到 `dist/visual-qa/`。富文本对话矩阵主动聚焦输入框，
  用于人工核对四主题的焦点颜色；
  其余继续核对主题结构差异、浅色终端背景与 dim 对比度、富文本、固定输入区、窄宽响应式和
  遮罩无重排。隐藏窗口截图会先丢弃一次未稳定合成帧，图片属于构建产物。
- `npm run test:conpty` 在一次性 `userData` 下加载真实工作区与 PowerShell ConPTY；最大化后连续创建
  十个额外对话，并发替换全部十一个 PTY，保持后台状态读取每个真实 PowerShell 的 WindowWidth/Height，
  对照各自 generation 的尺寸回声。随后保持最大化逐个切换，核对 xterm 画布铺满显示区并截图，再输出
  24 条带序号证明行，在 820/1400/900/1280/1180px 间往返调整 BrowserWindow；每次 resize 都等待
  preload 的权威 `terminal:size`，不靠固定睡眠。截图后连续执行三轮 restart → stop → start，再让最终
  generation 输出唯一 sentinel 并立即 `exit`，断言 data 先于 `stopped`、停止后没有同 generation
  迟到数据、旧 generation 的 `stopped/error` 不会覆盖最终运行状态。该 Windows 专用烟测已作为
  production build 后独立运行；首次命令、最终尺寸和 sentinel 输出都使用 30 秒硬上限，
  以容纳 GitHub Windows Runner 上 Electron/node-pty/PowerShell/Defender 的冷启动，但仍按 50ms
  探测立即继续而不是固定等待。成功和失败均先关闭该测试窗口自己的会话，再删除临时用户目录。
- `npm run test:control-theme` 在隐藏窗口里加载渲染入口，遍历全部按钮并读取计算样式，把
  `border-top-style: outset`（Chromium 未被覆盖的原生按钮）列成清单。源码断言只能守住已知的
  几个选择器，这条烟测才是「有没有漏网的原生控件」的全量答案，当前结果是 163 个按钮全部命中
  主题。
- `tests/main/application-proxy.test.ts` 用临时目录和可逆安全存储替身验证密码不落明文、留空保留、清空
  账号删除、SOCKS5 CLI 拒绝、IPv6 URL 编码、Electron 规则、CLI 环境和候选解析。
- NSIS 的 `installerLanguages` 固定为 `zh_CN`，安装向导不会随系统语言退回英文。
- `npm run build`：clean 后立即写入无凭据的 `dist/build-source-identity.json`（完整 Git HEAD、
  `package-lock.json` SHA-256、clean-tree fact），再生成图标、typecheck 并编译三个进程。开发构建可记录
  dirty fact；最终 release 只接受 clean identity。该文件进入 ASAR，manifest 与 frozen COS revalidation
  都必须把它和当前源码精确匹配。
- `npm run dist`：构建 Windows x64 NSIS 安装包；Electron Builder 的 `directories.output`
  固定为 `outputs/`，安装程序、Blockmap、更新元数据和解包产物均直接写入该目录，不再执行
  二次复制或向项目根目录发布。公开应用标识固定为 `io.github.aeonusovo.claudedock`，不得继续使用
  旧维护者命名空间。
- release manifest 使用 pinned `7zip-bin` 解压 NSIS 与唯一 `app-64.7z`，把 `app.asar`、完整 unpacked tree
  和 updater YAML 逐字节绑定到 `win-unpacked`；外部 gzip blockmap v2 的每个 BLAKE2b-144 chunk 也会
  重算。两组确定性 cohort evidence 在 frozen COS validation 中重新检查并精确比较。
- 发布版本结合 SemVer 与项目发布尺度：不兼容或架构级 API/数据/交互变更升主版本，有明确发布
  价值的成组/重大新功能升次版本，小功能优化、修复、文档、构建与维护改动升修订版本；避免因单个
  细小行为变化机械升次版本。版本必须同时写入 `package.json` 与 `package-lock.json`。
- `build/installer.nsh`：在辅助安装器的目录页后插入桌面快捷方式复选框；取消勾选时在
  electron-builder 完成默认快捷方式步骤后删除该快捷方式；静默安装未经过选项页时沿用打包器默认行为。

2026-08-07 的依赖安全修复把 `js-yaml` 从 4.3.0 升级到 4.3.1，把 `mermaid` 从 11.16.0 升级到
11.16.1；完整 `npm audit` 随后报告 0 个漏洞。

## 关键取舍与限制

- 采用“应用自建并控制 PTY”，而不是注入或劫持外部控制台；后者不稳定且扩大权限边界。
- Windows 原生模块采用 `@lydell/node-pty` 的预编译分发；API 与微软 node-pty 上游保持
  同源，避免要求本机安装 Spectre 缓解 C++ 库。
- 项目工作区以应用进程生命周期为边界，不持久化会话列表、终端进程或 xterm.js 缓冲。
- 保存或切换 Claude 接入不会热修改已运行 PowerShell 的环境；受保护启动会重建当前项目
  终端。这是避免把密钥写入可见终端输入和历史的有意取舍。
- Windows 10 1809 之前没有所需 ConPTY API，不在支持范围；最小窗口为 820 × 640。
- 应用自身的 COS 当前通道检查、显式下载和 NSIS 重启安装已经实现；更新器校验 `rc.yml` 或
  `latest.yml` 的 SHA-512 并拒绝降级。GitHub Releases 只提供手动安装与历史记录。退出后的 PTY 恢复
  仍未实现。

## 外部依据

- Claude 官方 MCP Apps 设计规范（明亮/深色令牌、排版层级、WCAG）：
  <https://claude.com/docs/connectors/building/mcp-apps/design-guidelines>
- Claude 官方透明主题规范：
  <https://claude.com/docs/connectors/building/mcp-apps/transparent-theming>
- Telegram Desktop 官方仓库（系统 UI 字体、圆形发送按钮与纸飞机/涟漪交互基线）：
  <https://github.com/telegramdesktop/tdesktop>
- Telegram Desktop 官方输入与发送按钮样式源：
  <https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/chat_helpers/chat_helpers.style>
- Telegram Desktop 官方 changelog（发送/回复涟漪与消息发送动画）：
  <https://github.com/telegramdesktop/tdesktop/blob/dev/changelog.txt>
- Telegram Web A 主题与动效令牌实现：
  <https://github.com/Ajaxy/telegram-tt>
- Claude Desktop 官方导航教程（当前桌面输入区与附件入口）：
  <https://claude.com/resources/tutorials/navigating-the-claude-desktop-app>
- Claude 官方文件上传说明：
  <https://support.claude.com/en/articles/8241126-upload-files-to-claude>
- Fontsource 字体文件仓库：
  <https://github.com/fontsource/font-files>
- Electron Security：
  <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron Tray：
  <https://www.electronjs.org/docs/latest/api/tray>
- Electron `app.setLoginItemSettings`：
  <https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows>
- Microsoft Windows 应用设置设计指南：
  <https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings>
- Electron `webUtils.getPathForFile`：
  <https://www.electronjs.org/docs/latest/api/web-utils>
- node-pty：
  <https://github.com/microsoft/node-pty>
- `@lydell/node-pty` 预编译分发：
  <https://github.com/lydell/node-pty>
- xterm.js addons：
  <https://xtermjs.org/docs/guides/using-addons/>
- xterm.js GitHub（IME、CJK 与主题能力）：
  <https://github.com/xtermjs/xterm.js>
- Electron Windows 原生 JavaScript 对话框关闭后的输入焦点问题：
  <https://github.com/electron/electron/issues/19977>
- Electron 对该焦点问题的当前修复：
  <https://github.com/electron/electron/pull/50770>
- Codex 官方仓库、Windows 安装与 ChatGPT 登录入口：
  <https://github.com/openai/codex>
- Codex 官方 Windows 安装脚本：
  <https://github.com/openai/codex/blob/main/scripts/install/install.ps1>
- Codex App Server 协议与账号方法：
  <https://learn.chatgpt.com/docs/app-server>
- Codex 官方认证说明：
  <https://learn.chatgpt.com/docs/auth>
- OpenAI 官方论坛对 Tibo 的 Codex 负责人身份说明：
  <https://forum.openai.com/public/events/codex-is-for-everyone-why-codex-matters-beyond-code-fa40puy7wi>
- Tibo 转引 Theo 的 CLIProxyAPI / `claudex` 三步公开实践：
  <https://x.com/thsottiaux/status/2076119366647894371>
- OpenAI 当前 ChatGPT 订阅支持的 Codex 客户端：
  <https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan>
- Claude Agent SDK 系统提示词语义（省略 = 空提示词，非 Claude Code 预设）：
  <https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts>
- Claude Agent SDK 与 CLI 的功能差异、`settingSources` 默认值：
  <https://code.claude.com/docs/en/agent-sdk/claude-code-features>
- Claude Code 会话 JSONL 格式不稳定声明：<https://code.claude.com/docs/en/sessions>
- Claude Code 只读 `CLAUDE.md` 不读 `AGENTS.md`，及 Windows 符号链接限制：
  <https://code.claude.com/docs/en/memory>
- `AGENTS.md` 支持请求（长期开启、无维护者回应）：
  <https://github.com/anthropics/claude-code/issues/6235>
- Codex `AGENTS.md` 发现规则与 `project_doc_fallback_filenames` 顶层键要求：
  <https://learn.chatgpt.com/docs/agent-configuration/agents-md.md>、
  <https://github.com/openai/codex/issues/22454>
- Codex 从 Claude Code 导入配置与会话：<https://learn.chatgpt.com/docs/import.md>
- CC Switch 官方开源仓库（配置管理能力）：
  <https://github.com/farion1231/cc-switch>
- CC Switch Codex OAuth 反向代理说明：
  <https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.1-add.md>
- CLIProxyAPI 官方仓库（Codex OAuth 与 Claude 兼容端点）：
  <https://github.com/router-for-me/CLIProxyAPI>
- CC Switch 官方 Releases 与 deep link 导入协议：
  <https://github.com/farion1231/cc-switch/releases>、
  <https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.3-deeplink.md>
- MCP Registry 官方说明与 preview API 文档：
  <https://modelcontextprotocol.io/registry/about>、
  <https://registry.modelcontextprotocol.io/docs>
- Electron `ProxyConfig` 与代理认证回调：
  <https://www.electronjs.org/docs/latest/api/structures/proxy-config>、
  <https://www.electronjs.org/docs/latest/api/app#event-login>
- electron-builder 自动更新、发布通道、AppUpdater 与 generic feed 配置：
  <https://www.electron.build/docs/features/auto-update/>、
  <https://www.electron.build/docs/tutorials/release-using-channels/>、
  <https://www.electron.build/docs/api/electron-updater.class.appupdater/>、
  <https://www.electron.build/docs/api/builder-util-runtime.interface.genericserveroptions/>
- Claude Code LLM gateway：
  <https://code.claude.com/docs/en/llm-gateway>
- Claude Code 连接网关与官方 1-token 验证：
  <https://code.claude.com/docs/en/llm-gateway-connect>
- Claude Code 网关协议：
  <https://code.claude.com/docs/en/llm-gateway-protocol>
- Claude Code 环境变量：
  <https://code.claude.com/docs/en/env-vars>
- Claude Code 子代理与并发/派生深度：
  <https://code.claude.com/docs/en/sub-agents>
- Claude Code MCP 与动态工具搜索：
  <https://code.claude.com/docs/en/mcp>
- Claude Code 官方插件目录与市场语义：
  <https://code.claude.com/docs/en/discover-plugins>、
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Claude Code Fast mode：
  <https://code.claude.com/docs/en/fast-mode>
- OpenAI API Fast mode / service tier：
  <https://developers.openai.com/api/docs/guides/fast-mode>
- OpenAI Codex speed：
  <https://learn.chatgpt.com/codex/agent-configuration/speed>
- Codex 模型 service-tier 目录：
  <https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json>
- CLIProxyAPI 7.2.117 Claude→Codex translator：
  <https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.117/internal/translator/codex/claude/codex_claude_request.go>
- Claude Code settings 与 `--settings` 优先级：
  <https://code.claude.com/docs/en/settings>
- Claude Code 模型配置：
  <https://code.claude.com/docs/en/model-config>
- Claude Code sessions：
  <https://code.claude.com/docs/en/sessions>
- Claude Code commands：
  <https://code.claude.com/docs/en/commands>
- Claude Code 高档 effort 与 disabled thinking 的已知兼容问题：
  <https://github.com/anthropics/claude-code/issues/76689>
- Claude Code changelog（`/theme` 与自定义主题）：
  <https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>
- Claude Code 官方安装与更新：
  <https://code.claude.com/docs/en/installation>
- Claude Code 插件发现与管理：
  <https://code.claude.com/docs/en/discover-plugins>
- Claude Code 插件市场：
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Claude Code statusLine：
  <https://code.claude.com/docs/en/statusline>
- Claude Code 数据与 WebFetch 预检：
  <https://code.claude.com/docs/en/data-usage>
- LiteLLM Anthropic `/v1/messages` 统一端点：
  <https://docs.litellm.ai/docs/anthropic_unified/>
- DeepSeek 官方 Coding Agents / Claude Code 接入指南：
  <https://api-docs.deepseek.com/guides/coding_agents/>
- Claude Code Router 仓库、Windows 图形版与默认端口：
  <https://github.com/musistudio/claude-code-router>
- Claude Code Router 官方 Releases：
  <https://github.com/musistudio/claude-code-router/releases>
- Claude Code Router 基础配置：
  <https://musistudio.github.io/claude-code-router/docs/cli/config/basic/>
- Claude Code Router CLI 安装：
  <https://musistudio.github.io/claude-code-router/docs/cli/installation/>
- PowerShell PSReadLine 多行编辑：
  <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_line_editing>
- npmmirror registry：
  <https://developer.aliyun.com/article/878125>
- Node.js 原生模块 ABI（`process.versions.modules`）：
  <https://nodejs.org/api/process.html#processversions>
- `better-sqlite3` 原生模块与 Electron 故障排查：
  <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md>
- Anthropic 质量问题复盘：
  <https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues>
