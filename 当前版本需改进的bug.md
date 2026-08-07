# 当前版本需改进的 bug

> 状态：5.0.0-rc.1 已完成本地实现、视觉巡检与候选包验证；Draft PR #36 的 CI 已通过，等待审查
>
> 决策基线：ClaudeDock 4.6.2
>
> 目标候选版本：ClaudeDock 5.0.0-rc.1

## 1. 文档目的

本文记录 4.6.x 已确认的产品与架构缺陷，以及 ClaudeDock 5.0 的最终实施规格。文中不再保留
“候选方案”或“待确认”项；实现代理不得自行换回旧终端优先架构，也不得把暂未适配的命令或能力
静默降级为普通提示词。

5.0 的核心变化是：**Claude 项目默认使用结构化原生对话，PowerShell/xterm 退为用户明确进入的
高级终端。** Codex App Server 原生接管因协议仍处于实验阶段，放在 Claude 迁移完成后的后续版本；
5.0 只建立共享接口和能力模型，不把当前 Codex TUI 伪装成原生支持。

## 2. 已确认的总体架构

### 2.1 隔离运行与测试

- 在任何 store、runtime、单实例锁或工作区恢复之前建立 `RuntimeProfile/AppPaths`。
- 测试默认使用独立临时 userData、home、项目、UUID 和假适配器；禁止读取生产配置、真实凭据、真实
  Claude/Codex 历史、真实插件/MCP 目录或未知 PID。
- 测试配置禁止工作区恢复、托盘、更新器、安装器、外部路由写入和生产单实例锁。
- 真实 CLI 烟测必须由维护者显式启用，使用临时项目与全新 UUID，并明确提示可能消耗额度。

### 2.2 结构化运行时

- 建立统一 `ConversationAdapter` 与带 revision 的结构化事件：文本块、工具生命周期、权限、提问、
  计划、MCP、附件、后台任务、用量、模型、错误和恢复状态。
- Claude 默认使用官方 TypeScript Agent SDK，并指向用户机器上已安装的 `claude.exe`；安装包不得
  捆绑第二份 Claude Code。
- renderer 只消费窄 preload API 和结构化事件，不解析 ANSI/TUI 屏幕来猜权限、计划或工具状态。
- xterm/ConPTY 只作为显式高级终端或官方工具兜底，不自动替代原生对话。

### 2.3 会话唯一所有权

- canonical key 固定为 `(runtime, normalized project path, lowercase conversation UUID)`。
- 同一 key 最多一个 active/starting owner；标题、terminal slot ID、PID 均不能参与身份判定。
- 原生对话切换到高级终端时：保存草稿 → 停止原生 owner → 精确 resume UUID → 提交终端 owner。
  任一步失败都恢复原 owner，绝不允许 SDK 与 TUI 同时写同一 transcript。
- 从高级终端返回原生模式执行反向交接；未知命令入口也必须遵守同一事务。

### 2.4 原生命令能力

- 受支持 Claude Code 版本的所有官方内置斜杠命令必须进入完整矩阵：SDK 动作、ClaudeDock 原生页面、
  原生表单、等价本地操作或明确的“原生 UI 下不适用”说明。已知命令缺少处理即阻塞 RC。
- Skills、Plugins、MCP 命令与内置命令分开建模；能结构化发现的命令注册为原生能力。
- 新版未知命令必须拦截，显示兼容性说明并提供高级终端入口；绝不作为普通提示词发送，也不使用无法
  确认交互/权限语义的通用文本包装器冒充原生适配。

## 3. 各问题的最终实施规格

### 3.1 Ultra Code 显示成 X-High

Claude Code 的 `ultracode` 是“请求 X-High + 工作流编排”的会话预设，状态行只回报 X-High 并不
代表切换失败。当前缺陷是 renderer 用 applied 值覆盖了 requested preset，导致菜单和底栏看起来跳回
X-High。

最终行为：

- 收起按钮只显示“Ultra Code”；“工作流编排 · 实际 X-High”放在展开说明、悬停提示和辅助技术描述中，
  不在对话标题或按钮旁重复占位。
- 菜单勾选以 requested preset 为准，实际档位单独展示；状态行迟到不能抹掉 Ultra 请求态。
- 底层仍发送原子 `/effort ultracode`，不能产生“Low + Ultra”等 Claude Code 不支持的组合。
- Claude 的 `max` 与 `ultracode` 仅当前会话有效，不在重启后静默重放。
- Codex 与 Claude 分开建模。当前 Codex 0.146.0 的模型目录将 `xhigh`、`max`、`ultra` 分列；对
  GPT-5.6 Sol/Terra，Ultra 为“最大思考 + 自动任务委派”，不是 X-High，也不比 Max 更深。Codex
  后续原生迁移时从 `model/list` 动态生成同一档位菜单。

### 3.2 窗口缩放与主题同步

默认原生 DOM 对话必须随窗口连续重排，因此不再让 Claude Ink TUI 的字符网格决定主要界面布局。
消息、工具、代码差异、输入、浮层和交互坞都由 DOM/CSS 布局，不得出现旧网格裁剪、重复螃蟹或 resize
期间的字符残影。

主题切换必须立即更新所有 ClaudeDock 管理的内容，包括代码修改背景、用户提示词背景、工具状态和
交互浮层。颜色、字体、圆角、阴影、间距和动效只能来自主题 token。

高级终端仍保留真实边界：已经写入 xterm scrollback 的第三方 TrueColor 单元无法可靠重映射。若后续
维护该界面的 resize，应采用 RAF 合并、renderer/main 双层同尺寸去重和唯一 settle，不使用重复
SIGWINCH 或通用 Ctrl+L 猜测修复。

### 3.3 崩溃、断电与强制重启恢复

- 新会话在启动前预分配 UUID；Claude JSONL 继续作为 transcript 真值。
- 使用独立、原子写入的 `recovery-journal.json`，不升级 `workspace.json v1`。日志只记录 project、
  UUID、owner、启动配置指纹、提交阶段、时间和 clean marker。
- 待确认提示词使用 Electron `safeStorage` 加密；持久化失败时阻止发送并把原文保留在 composer。
- 正常退出必须在 runtime/workspace 真正停止且最终对账后写 clean marker。
- 启动时与实际 JSONL 对账并显示“上次异常中断”恢复卡片，不静默自动启动多条 CLI。
- JSONL 已存在则只精确 resume；只有 prepared/明确被阻止的内容恢复为未发送草稿。
- 已放行但 JSONL 未确认的内容标记“结果未知”，只恢复为待核对草稿，绝不自动重发。
- recovery journal 只能提高异常中断的可发现性，不能补写 Claude 尚未落盘的正文或恢复未发送的
  高级终端原始按键。
- 现有明文 `localStorage['claudedock.composerHistory']` 迁到主进程安全存储；默认只保存在内存，
  用户可显式开启“在这台电脑上安全保存输入历史”。

### 3.4 历史与进行中对话重复

- 只有 active/starting Claude owner 的 UUID 从历史列表移走；runtime 失活、退出、停止、错误或关闭后
  立即重新进入历史。
- 点击已经有 owner 的历史会话只聚焦现有界面，不创建第二个 runtime。
- 恢复请求按 key 合并；restore 的 slot 创建、SDK/PTY 准备、owner 提交必须事务化，失败关闭刚创建
  的 slot 并恢复原选择。
- 历史定向 restore、rename、delete 一律使用文件名派生的 `conversationId`；新建/continue/picker 在
  得到结构化 UUID 后再与 `<uuid>.jsonl` 对账。
- 高级终端内原生 `/resume` 事前无法获知 UUID 时，得到身份后必须冻结冲突实例并提示切换；默认保留
  已稳定 owner，不能静默双开或杀死旧进程。

### 3.5 历史右侧时间与操作被遮挡

- 历史行使用 `grid-template-columns: minmax(0, 1fr) <trailing-slot>`。
- 时间文本与独立删除按钮位于同一尾槽并交叉淡入/淡出，不能嵌套按钮；键盘 focus 时删除按钮可达。
- 两层滚动区使用稳定 scrollbar gutter 和主题间距；行设置 `min-width: 0`、`width: 100%` 与明确
  overflow；时间使用 nowrap 和 tabular numerals。
- 固定槽宽必须通过 token/minmax 适应 200% 缩放和最长时间文本，禁止魔法像素。

### 3.6 图片粘贴与上传

- Claude 原生输入首期支持图片粘贴、拖放和文件选择，并以附件 chip 显示待发送状态。
- 独立对话现有附件链补齐 `clipboardData.items/getAsFile()` 与 Electron `clipboard.readImage()` 兜底。
- 项目视图不再把拖入图片误判为项目文件夹；xterm Ctrl+V 不能吞掉图片剪贴板。
- 主进程复核 runtime、session、generation、平台、模型与能力 profile 后才接收附件。
- 校验 MIME 魔数、大小、像素数、路径规范化、junction/symlink 和危险 SVG；日志不记录路径或 base64。
- 应用副本保留到结构化 ingestion 确认、会话结束或 TTL，到期做崩溃孤儿 GC；绝不删除用户源文件。
- Codex 运行中图片留到 App Server 会话所有权迁移，当前 TUI 不与 app-server 双写。

### 3.7 当前对话摘要与后台任务

- 顶部保留始终可发现的当前对话摘要按钮；无任务时只显示图标。
- 活动出现时，任务粒子汇聚到按钮并展开短标签；`prefers-reduced-motion` 使用状态点和数量。
- 点击打开临时浮动检查器，不可拖动、不持久固定、不成为单独页面；点击外部、失焦或 Esc 走退出
  动画关闭。
- 内容只针对当前对话，分为环境、活动、来源；切换对话立即切换快照。
- 取消按钮只在来源提供真实 cancellable action 时显示；失联 unfinished 标为“状态待确认/已失联”，
  不伪装成成功完成。
- Stop 事件中字段存在时（包括空数组）执行权威 reconciliation；任务与 web process 分开计数；每次
  从基础状态与 overlay 重新计算标题，禁止残留“后台任务仍在运行”。

### 3.8 ConPTY 连接提示

ConPTY 是本机 PowerShell/CLI 伪终端，不是网络连接。成功时完全隐藏技术文案，完整状态只在诊断页
可查。

首次失败按 session + generation 显示主题化对话框，说明影响并提供“重新连接、运行诊断、复制脱敏
诊断”。主进程必须保留 error category/code，检查 cwd、PowerShell、ConPTY 和原生模块；只有证据
充分时才显示针对性修复。用户主动停止时不弹窗。

### 3.9 更新中心文案与进度

- 将“下载中心”改为统一“任务与下载”，用 `domain/action/target/startedAt/stage` 描述 operation。
- 插件刷新、更新、启用、停用、安装和卸载必须显示准确动作与插件名；“全部更新”显示动态队列位置。
- native updater、WinGet、npm 输出经脱敏后流式显示真实阶段和已用时间。
- 只有总字节数真实存在时显示百分比、速度与 ETA；未知总量明确说明，不伪造进度。
- 首期不自建完整 npm 依赖下载器；若未来仅托管顶层 tarball，只能对该下载阶段承诺真实速度/ETA。

### 3.10 Fast 体感与状态

- 删除所有固定“1.5X”标签，统一称“Fast”。
- 状态为互斥的“未请求、已请求、上游确认、已回退”；只有结构化响应提供 actual tier 才能显示确认。
- Fast 只可能改善上游模型推理，不加速本地文件、构建、测试、工具和任务排队；高 effort 可能抵消
  总耗时收益。
- 首期只显示可验证的 `UserPromptSubmit → Stop` 总耗时和已观测工具/后台阶段；xterm 首字节不能冒充
  TTFT。TTFT、token/s 和网关拆分只有结构化 telemetry 提供后才显示。
- 不在后台自动做 A/B 测速；任何额度消耗型诊断必须由用户显式启动。

### 3.11 模型能力与状态栏联动

- 建立版本化 `ModelCapabilityProfile`，key 至少包含 runtime、provider、endpoint identity、model
  family、CLI/gateway version。
- profile 描述原生 effort 形态、Fast 机制与确认方式、输入模态、附件限制、上下文和证据来源。
- effort 控件支持 enum、toggle、numeric budget、automatic-only、none、unknown，不硬编码跨厂商通用
  七档中文名。
- 解析优先级：实时结构化元数据 > 已验证静态目录 > 隔离首次探测 > unknown fail-closed。
- renderer 只消费带 revision 的 `ModelControlState`；模型、effort、Fast、附件和权限一次原子更新，
  上一模型迟到状态不能覆盖新模型。
- 不支持的控件按已确认方案从当前状态栏隐藏，并使用短 reflow 动画；减少动态效果时即时更新。
- 未知模型在隔离会话做最小探测并缓存，不污染用户对话；“Fable”等仅凭名称出现的模型不建立规则。

## 4. 原生对话交互规范

- Markdown 流按稳定 block 增量渲染，保留原始字符串、空白、分隔线和代码围栏，不 trim 或合并文本块。
- thinking 默认折叠，仅显示协议提供的 summary，不暴露或伪造隐藏推理。
- 工具卡片：运行中、失败、高风险默认展开；正常成功项折叠。
- 底部 operation dock 出现时完整替换 composer，草稿安全保留；多个请求按 FIFO 排队，界面一次只
  显示队首请求，完成后以同一进退场动效切换下一项，不堆叠卡片或重复显示模型/档位说明。
- 权限只显示 SDK 真正提供的 scope；持久授权与单次授权视觉分离。
- AskUserQuestion/MCP 表单支持单选、多选、自由文本；secret 字段不进入日志。
- 计划以完整 Markdown 卡片显示，可全屏检查；审批模式只展示 SDK 实际支持的选项。
- 运行中输入直接引导当前轮次的下一个安全边界，不强杀已经运行的命令；前台 interrupt 和后台
  stopTask 分开。
- 项目 Hooks/MCP/Skills/settings 首次使用前显示一次明确的 workspace trust 确认。

## 5. UI 截图与动效强制门槛

每个新增或修改组件必须执行：构建隔离 fixture → 生成截图 → 逐张实际打开检查 → 修正 → 重新截图 →
真实 Electron 窗口完整交互。只生成文件或只通过 bounding-box 断言不算完成。

截图矩阵：

- 四主题：Claude 明亮、Telegram、石墨深色、午夜。
- 基础窗口：820×640、900×640、1180×760。
- 边界：270/320/560px 项目栏、滚动条有/无、长中英文、空/加载/成功/失败、125%/150%/200% 缩放。
- 浮层和交互组件：关闭、进入中间帧、完全打开、退出中间帧。
- 产物保存于 `dist/visual-qa/<feature>/`，manifest 记录主题、尺寸、缩放、状态和动画时间点；不提交 Git。

逐项验收：

1. 布局、层级、留白、对齐、对比度合理且美观。
2. 四主题保持各自字体、颜色、阴影、圆角和动效调性。
3. 复用统一组件和 design token，不出现局部魔法颜色、尺寸或时长。
   文字操作统一使用 `.button` 及语义变体，标题栏与浮层 chrome 统一使用 `.icon-button`；同类按钮
   不得重新声明字号和外观。
4. 进入/退出使用主题 `durEnter/durExit/ease`，退出完成后才移除 DOM，禁止 `display` 闪现。
5. `prefers-reduced-motion` 保留完整焦点与状态行为，只移除非必要运动。

现有 `visual-smoke` 必须增加动态关键帧 fixture；最终还要使用 Windows Graphics Capture 检查真实
Electron 窗口，而不是只查看隐藏窗口的静态 renderer fixture。

## 6. 测试与发布门禁

- 纯协议与 reducer 测试：事件顺序、迟到 revision、工具/权限队列、Markdown 保真。
- 所有权与恢复：同 UUID 连点、existing owner 聚焦、失败回滚、inactive 回历史、unknown-target gate、
  `/resume` 碰撞、0-byte/残缺 JSONL、journal 截断/损坏/陈旧和 clean marker 时序。
- 故障注入：UUID 前后、prepared 前后、CR 后/hook 前、allow 后/JSONL 前、后台任务运行中、app/CLI
  进程强杀及 Windows 强制重启等价断点。
- 能力与附件：未知模型、模型降级、上一 revision 迟到、requested/actual 不一致、剪贴板来源、恶意
  文件、generation 变化和孤儿 GC。
- UI：四主题截图、真实 bounding box、键盘/焦点、减少动态效果、长文本和所有交互的进入/退出帧。
- 集成：假适配器覆盖文本、工具、权限、提问、计划、MCP、图片和任务；真实 CLI 只做显式隔离烟测。
- 完整运行 `npm run verify`、项目要求的视觉矩阵和 `npm run dist`；打包断言不存在第二份 `claude.exe`。
- 目标本地候选包为 `outputs/ClaudeDock-Setup-5.0.0-rc.1-x64.exe` 及同构建 blockmap、`latest.yml`、
  `win-unpacked/`。
- RC 仍不是稳定 Release。正式 5.0.0 必须完成受信任 Authenticode、签名 manifest、安装/卸载、更新、
  篡改、回退、TLS、镜像一致性与跨渠道 SHA-512 门禁。

## 7. 实施顺序

1. 合并安全、隔离测试、`ConversationAdapter` 和假适配器基线。
2. 实现 Claude SDK、单 owner、恢复日志和结构化会话状态。
3. 实现原生对话、operation dock、命令矩阵和图片附件。
4. 实现模型能力、Ultra/Fast、历史布局与主题同步。
5. 实现当前对话摘要、ConPTY 失败诊断和任务下载中心。
6. 完成四主题逐组件截图修正、故障注入、真实隔离 CLI 烟测、全量打包与分支审计。

## 8. 本地候选版验证结果

- `npm run verify` 全部通过：116 个测试文件、863 项测试，以及 lint、format、typecheck、layout、
  control-theme、build 和隔离 ConPTY 烟测。
- `npm run test:visual` 通过；原生视觉矩阵生成 56 张主题/尺寸/缩放/状态/动效截图。另以隔离假适配器
  驱动真实可见 Electron 窗口，完成 14 张权限、提问、计划、MCP、摘要和高级终端交互截图并逐张检查。
- `npm run dist` 生成安装器、blockmap、`latest.yml` 与 `win-unpacked/`；包内扫描确认没有第二份
  `claude.exe`，生产依赖审计为 0 个已知漏洞。
- 安装器和应用可执行文件当前为 `NotSigned`，因此只属于本地 RC 候选包；受信任 Authenticode、双渠道
  清单签名、安装/卸载与更新/回滚仍是正式 5.0.0 的发布阻塞项。
- 本地/远端分支已按祖先关系与 patch-equivalence 审计：PR #33 已 squash 合并；旧工作树提交已等价
  进入 `main`；旧更新中心 Draft PR 已被主线后续实现覆盖；独立 Dependabot PR 不混入本次架构发布。
- Draft PR #36 的 GitHub Actions `security` 与 `verify` 均通过；PR 保持 Draft，未创建版本标签或
  稳定 Release。

## 9. 外部能力依据

- [Claude Code 会话存储与恢复](https://code.claude.com/docs/en/sessions)
- [Claude Code 交互模式与 Windows 图片粘贴](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code 模型与 effort](https://code.claude.com/docs/en/model-config)
- [Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode)
- [OpenAI 模型指南](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)

外部能力随版本变化。实现与发布验收必须重新读取结构化能力和官方文档，未知时保守禁用，不能把本文
记录的时间点事实永久硬编码。
