# ClaudeDock 控制面板

ClaudeDock 是面向 Windows 的开源 Electron 桌面控制面板，用图形界面管理多个项目的真实
PowerShell/ConPTY 终端、Claude Code 与 Codex 开发会话、模型接入、MCP、插件和软件更新。

当前代码版本为 **5.0.0-rc.8**，许可证为 **Apache-2.0**。Claude 项目的“新建安全会话”、
“继续最近”“选择历史”和历史记录点击默认进入真实 PowerShell/ConPTY 终端；结构化原生对话只通过
终端工具栏的“原生对话”按钮显式进入，不会因恢复记录自动抢占终端界面。原生路径仍由 Claude Agent SDK
解析用户本机的 `claude` 命令；NPM 安装时会沿启动器定位同一软件包内的 `bin/claude.exe`，ClaudeDock
不捆绑第二份 Claude Code。用户提示词使用独立气泡，Claude 回复在 PowerShell 风格输出壳中按帧平滑
增长，最终完整帧只负责收口而不会重复追加。Codex 5.0 RC 仍使用原生 TUI，只复用能力与所有权接口，
不把实验性 App Server 伪装成已完成的结构化会话。正式稳定版必须同时通过可信
Authenticode 签名、GitHub Release 与国内 HTTPS 镜像一致性验收；在这些门禁完成前，本地构建
只用于开发和测试，不应被描述为正式签名发行版。

## 项目边界

- 每个项目拥有独立的 Windows PowerShell/ConPTY 会话，可以同时在后台运行。
- 每个项目可选择 Claude Code 或 Codex。ClaudeDock 只负责启动与显示必要状态，不读取或改写
  Codex 的 OAuth 凭据，也不修改 Codex、Claude Code 或 Windows 的系统级 API 路由。
- 路由功能只服务于 ClaudeDock 启动的 CLI 会话。应用不会安装、卸载、终止或改写 Claude、Codex、
  CCR 的桌面 App；检测到桌面版后台时会拒绝接管，CCR 配置保存固定使用 `applyProfile: false`。
- 模型/API 配置只注入 ClaudeDock 为当前项目启动的子进程。保存的密钥使用 Electron
  `safeStorage`（Windows 上为 DPAPI）加密，不写入项目、命令行或终端历史。
- “对话”工作台支持 Anthropic Messages 与 OpenAI Chat Completions 兼容接口；模型输出在界面中
  标记为“AI 生成”。本机聊天历史不是加密保险箱，敏感内容应及时删除。
- 外部应用代理仅接受用户明确提供的 HTTP/SOCKS5 地址，并只传给用户勾选的进程。ClaudeDock
  不提供第三方网络服务，不修改 Windows 系统代理、DNS、路由表或网卡，也不读取或迁移旧版网络
  配置。
- 网络预检只检查本机可见路径与服务商配置中的官方 DNS/HTTPS/TLS/CLI 端点，不请求第三方公网
  地址、地区、ASN 或网络信誉服务，也不根据用户位置作判断。

更完整的数据处理说明见 [隐私说明](docs/PRIVACY.md)，中国大陆公开发行边界见
[合规评估](docs/LEGAL_COMPLIANCE.md)。

## 主要能力

- 多项目、托盘后台运行、项目/对话历史、默认 PowerShell/ConPTY 安全终端与显式可选的原生 Claude 对话。
- 原生消息流保留 Markdown 块顺序、空白、代码围栏、工具状态、计划、权限、提问、MCP 表单、图片和
  后台任务；同一助手轮次的 token 增量按稳定消息 ID 聚合，完成帧原位替换流式正文，不再产生逐字卡片或
  末尾重复整段。高风险、运行中与失败工具默认展开，普通成功项默认折叠。
- 原生权限栏把 `dontAsk` 准确显示为“仅预批准”：未预先批准的工具仍直接拒绝，但用户在当前提示词中
  明确要求选项或选择题时，Claude 可使用现有结构化选择卡，不必切到规划模式。项目默认开启高风险预置时
  显示“完全允许”，关闭预置后启动、切换与 adapter 三层均拒绝进入该模式。
- `(runtime, normalized project, UUID)` 单一 owner 阻止同一对话被原生会话、历史恢复和安全终端
  重复占用。从原生对话返回安全终端时会先保存草稿并精确恢复 UUID；任何失败均回滚到原生 owner。
- Claude JSONL 仍是正文真值。独立恢复日志只记录 owner、启动配置和提交阶段；待确认文本由
  Electron `safeStorage` 加密，无法持久化时阻止发送。不确定的提交只恢复为草稿，绝不自动补发。
- 真实 Agent SDK 输入一经本机队列接受，界面立即按 `clientSubmissionId` 显示对应用户消息；提交
  确认按对话隔离，迟到结果不能清空后来输入的草稿。单轮上游错误会显示失败消息并回到可重试状态；
  SDK 流致命退出会同时关闭死队列、释放 owner 与路由预约，后续发送不会落入无消费者的黑洞。
- 顶栏的“当前对话摘要”检查器按需显示环境、前台、子智能体、后台任务和来源；运行中、等待中、
  已完成使用相邻状态标签和独立语义色，行操作统一在右侧垂直居中。无活动时保持为图标，不再长期
  显示含糊的“后台任务正在运行”。
- 模型、effort、Fast、图片与权限控件由同一能力 revision 原子更新。Claude `Ultra Code` 在菜单中
  解释“工作流编排 · 实际 X-High”，标题栏不重复堆叠已由按钮表达的模型与档位；Fast 只显示
  未请求、已请求、上游确认或已回退，不承诺固定倍率。
- Claude/Codex 工作台共用静态指令注册表；完整调用名及版本边界见
  [CLI 指令清单](docs/cli-command-catalog.md)，动态 Skills、Plugins 与 MCP 指令仍以 CLI 原生 `/`
  列表为准。
- Claude Code 官方安装、版本门禁、项目级服务商接入、连接实测和会话状态。
- 实验性的“ChatGPT 订阅（ClaudeDock 托管）”预设：用户一次点击后，ClaudeDock 自动检测并补齐
  Claude Code，从 CLIProxyAPI 官方 GitHub Release 下载并校验 Windows x64 版本，在应用私有目录
  安装、打开 OpenAI 官方授权页、启动仅监听回环地址的网关，再从实时模型列表选择、实测并保存当前
  项目配置。应用或 Windows 重启后，手动/自动连接测试会先恢复这个应用自有网关，再验证已保存配置；
  网关进程停止不会再被误报为用户配置突然失效。
- Codex 官方 CLI/App Server 登录状态与项目启动；ChatGPT 登录凭据仍由 Codex 自身管理。
- Claude Code 底栏提供按接入和模型隔离的“速度”菜单：官方 Claude 使用原生 Fast，受管 GPT
  请求 `service_tier=fast`；默认始终为标准速度，原生 Codex 的速度仍由 Codex 自己管理。
- “新建安全会话”在点击后的同一事件循环内立即锁定，直到观察到新对话、新的运行中
  `ptyGeneration`（即使 Windows 复用了同一 PID）、新 PowerShell PID、Claude 退出回到原
  PowerShell，或明确失败/关闭事件，避免准备期间重复重启终端。
- 终端底栏把上下文、官方额度窗口和受支持供应商余额收拢为“资源”菜单；用户可选择自动、
  上下文优先或额度优先。ClaudeDock 不用本地网关请求次数伪造 ChatGPT 订阅剩余额度。
- Claude 原生对话与独立模型对话均支持受限图片附件；Windows 剪贴板兼容 `items` 与主进程
  `readImage()` 回退，应用副本经过类型、大小、像素、路径与 SVG 安全检查并按会话/TTL 回收。
- 原生输入坞保持同一提交、附件、键盘和可访问性内核，同时随主题更换外壳：Claude 明亮使用柔和
  容器与圆形上箭头确认动效；Telegram 明亮使用紧凑扁平输入条、蓝色纸飞机、指针涟漪和发送飞行动效。
  “新建安全会话”只在真实启动事务中禁用，事务完成后立即恢复；Telegram 主题的可用按钮由浅蓝
  平滑加深为深蓝，计算样式烟测会逐主题验证基础色与悬停色，而不是把灰色禁用态误作悬停反馈。
  顶栏“工作台”和“主题”复用同一个菜单按钮组件；主题只有一个入口，点击后打开主题化选择卡片。
- Claude Code 插件、MCP、Claude Code Router 与 CC Switch 官方安装/导入边界。
- 标题栏统一更新中心聚合 ClaudeDock、Claude Code、Router 与插件更新；“任务与下载”精确显示动作、
  对象、阶段、队列和已用时间，只有存在真实字节总量时才显示百分比、速度与 ETA。
- 应用更新、依赖许可清单、安全报告与可重复 CI 门禁。

设计和交互约束见 [design.md](design.md)，架构、安全与发布实现见
[technical.md](technical.md)。

## 安装与使用

正式版本发布后，从仓库的
[GitHub Releases](https://github.com/AeonusOvO/claude-dock-control-panel/releases) 下载
`ClaudeDock-Setup-<version>-x64.exe`。安装器支持选择安装目录和桌面快捷方式。

发布前请在 Windows 的文件属性或 PowerShell 中验证 Authenticode：

```powershell
Get-AuthenticodeSignature .\ClaudeDock-Setup-<version>-x64.exe | Format-List
```

只有 `Status` 为 `Valid`、签名主体与发行说明一致且时间戳/证书链受 Windows 信任时，才应作为
正式安装包使用。项目不会用自签名证书或 `NotSigned` 状态冒充正式签名。

启动后：

1. 从左侧添加一个项目文件夹；应用会为它创建独立终端会话。
2. 选择 Claude Code 或 Codex 作为项目开发引擎。
3. Claude Code 项目在“接入”中选择服务商、模型和认证方式；真实测试最多请求 1 个输出 token，
   可能产生少量供应商费用。“新建安全会话”、继续和历史恢复默认打开 PowerShell/ConPTY；需要结构化
   Agent SDK 界面时，再点击终端工具栏的“原生对话”。
4. Codex 项目使用官方 ChatGPT 浏览器登录或设备码登录；ClaudeDock 不接触登录令牌。
5. 关闭主窗口默认只隐藏到系统托盘；从托盘菜单可彻底退出。托盘“退出”始终先显示应用内确认，
   正在启动或运行的终端以及下载、安装等忙碌操作会逐项列出。
6. 点击标题栏的“检查所有更新”会打开统一结果窗口；即使没有更新也会给出明确空状态。执行更新后
   可在下载中心查看传输或安装进度。下载历史最多保留 100 条终态元数据，不保存下载 URL、输出路径
   或凭据，并可逐条删除或全部清空。

### 模型服务速度

“速度”与接入配置中的“小型/备用模型标识”是两件事：后者会切换到另一个模型，前者只选择同一
模型的服务档位。ClaudeDock 按开发引擎、接入、模型、认证方式和不含凭据的端点身份隔离保存速度
偏好；没有显式选择时始终使用“标准”，不会把一个模型的快速档泄漏到另一个模型或连接。

- **官方 Claude Fast**：仅向官方 Anthropic 接入、Claude Code 2.1.219+ 和已确认支持的
  Opus 5 / Opus 4.8 模型开放。选择后通过会话专用 `--settings` 请求 Claude Code 原生 Fast；只有
  statusLine 明确上报 `fast_mode: true` 才显示“Claude Fast 已开启”。组织资格、额度、最高约
  2.5x 的速度和更高单价均由 Anthropic 决定，ClaudeDock 不绕过组织检查；请求被拒时会如实显示
  “未生效”，并保留终端中的官方说明。
- **受管 GPT 1.5x**：CLIProxyAPI 7.2.117+ 且模型属于已验证的 GPT-5.4/5.5/5.6 系列时，
  ClaudeDock 向 Claude Code 会话注入
  `CLAUDE_CODE_EXTRA_BODY={"service_tier":"fast"}`。界面只显示“已请求 GPT 1.5x”，因为
  ClaudeDock 无法确认 ChatGPT 订阅上游最终是否采用 priority tier；该档可能更快，也会消耗更多
  额度，实际可用性和计费以 OpenAI/订阅策略为准。
- **原生 Codex**：本版不代管 Codex 自己的速度设置，底栏显示“速度 Codex 内管理”。

运行中的 Claude Code 会话切换速度时会重建当前 PowerShell，并用精确的
`--resume <conversation UUID>` 恢复同一对话；速度切换不会运行 `/compact`。切换模型时如果新的
模型需要不同速度 profile，也会走同一重启边界，避免继承旧模型的环境。

### 安全会话启动锁

点击“新建安全会话”“继续最近”或“选择历史”后，主按钮与三个入口会在第一个异步等待之前同步
禁用并设置 `aria-busy`；即使该项目尚无 Claude 状态缓存也一样生效。锁按 session 和 generation
隔离，旧请求的迟到成功或失败不能释放后来一次启动。

接入健康异常属于可修复预检，不会把“新建安全会话”渲染成透明的禁用按钮；只有真实启动忙碌时才
禁用。受管 ChatGPT 会先自动恢复本地网关，确实缺少 Claude Code、模型凭据或可用接入时，输入坞会
退出“正在启动”并显示对应的环境/配置提示。全新原生会话若在 Claude 创建 JSONL 前启动失败，会
回滚 owner、路由预约和空恢复记录，不伪装成一次可恢复的异常中断。

官方端点预检只作用于已经确认使用官方接入的项目；Claude 状态尚未加载时不会猜测接入类型，也不会
覆盖受管网关项目的启动入口。可用主按钮的悬停态沿用当前主题的强调色 token：Telegram 主题由蓝色
平滑加深，其他主题分别使用自己的强调色，不再通过降低透明度伪装成禁用状态。

IPC 返回成功并不代表新的终端生命周期已经可见，因此 renderer 不使用超时自动解锁。只有观察到
以下事实之一才恢复操作：新的 conversation UUID、新的运行中 `ptyGeneration`（即使 Windows 复用
了同一 PowerShell PID）、新的运行中 PowerShell/ConPTY PID、Claude 已活动后退出且原 PowerShell
仍在运行；明确的启动 IPC 失败、终端 `stopped/error`、会话关闭或删除也会释放对应锁。Codex 保持
独立启动状态，不与 Claude 的锁互相污染。

### 会话并发与运行时所有权

- 每次真实 PowerShell/ConPTY spawn 都由 `TerminalSession` 生成新的 `ptyGeneration`；停止不递增，
  重启只因一次新 spawn 递增一次。主进程按 8ms / 64KiB UTF-8 字节合并输出；renderer 的无损泵按帧
  调度、同一时间只保留一个 xterm 写入，每次最多 64Ki 个 UTF-16 code unit 且不切开代理对。实时输出
  不再因 renderer 队列过大而丢弃旧分块。两侧都绑定精确 generation 和缓冲/视图身份；自然退出会先
  同步发送该 generation 的末尾缓冲，旧定时器、RAF 或写入完成回调不能清空或渲染替代终端。
- 每次 Claude Code launch 独占
  `userData/claude/runtime/<session-id>/launch-<runtime-token>-<launch-generation>/`，其中同时存放
  `settings.json`、`metrics.json`、`signal.json` 与 `turn-stop.json`。异步读取完成后还会复核该 launch
  与精确 PTY 的所有权，不复用前一次启动的状态或信号文件。
- 直接 start/restart/stop 固定按“预检 → 失效旧操作 → 解除精确 generation 的 probe → 等待 unwind →
  复检 → generation-scoped 清理 → 同步 PTY 动作”执行。同一规范化项目目录的开发引擎切换会整体
  保留所有权；项目配置按目录 FIFO 执行“异步准备 → 同步提交 → 完成验证/恢复 → 所有权校验回滚”。
  准备 OpenAI 转换、历史记录或 Router 时原 profile 保持不变，提交前还会复核快照；事务屏障持续到
  完成或回滚状态发布结束，其他项目目录仍可并行。
- renderer 的 Claude、Codex 与开发引擎状态请求，以及 Claude 启动的确认和 IPC 结果，都由 per-session
  generation 隔离；删除会话时同步裁剪结果 tombstone。可执行竞态测试用假定时器、延迟 Promise、
  可控 PTY 回调和真实临时文件验证旧完成路径不能影响替代会话。

### ChatGPT 订阅接入 Claude Code（实验性）

2026-07-12，OpenAI Codex 负责人 Tibo 在公开 X 帖中分享了 Theo 使用 CLIProxyAPI 连接
Claude/Codex 鉴权、把 Claude Code 指向 GPT 模型并定义 `claudex` 别名的做法。ClaudeDock 把这条
公开实践收敛成图形化托管流程，但它仍不是 OpenAI 或 Anthropic 产品文档列出的 Claude Code 官方
接入：CLIProxyAPI 是独立的 MIT 许可第三方项目，当前条款、套餐限制与模型可用性仍然适用，并可能
随上游变化失效。

普通用户只需要在“接入 → 订阅接入（实验性）”选择“ChatGPT 订阅（ClaudeDock 托管）”，再点击一次
“一键安装并登录”。ClaudeDock 随后自动完成环境检测、缺失组件安装、授权、模型发现、真实测试和项目
保存；界面用 8 个实时阶段持续反馈，操作结束前主按钮保持锁定。

1. ClaudeDock 查询 CLIProxyAPI 官方 GitHub Release，只接受预期仓库、版本、Windows x64 ZIP 与
   GitHub 提供的 SHA-256 摘要；校验后解压到应用 `userData` 私有目录，生成仅监听
   `127.0.0.1` 的本地配置并隐藏启动进程。下载、校验、授权和配置完成前按钮持续锁定；即使界面
   刷新或重复触发 IPC，主进程也只复用同一个安装任务。用户不需要打开终端、CLIProxyAPI 控制台或
   CC Switch。
2. 浏览器会打开 OpenAI 官方授权页。这一步需要用户本人确认，ClaudeDock 不读取密码、Cookie 或
   OAuth Token；CLIProxyAPI 将自己的 OAuth 文件保存在 ClaudeDock 为它划定的私有认证目录。
3. 授权成功后，ClaudeDock 自动启动网关并读取 `/v1/models`；这个实时结果同时完成地址、密钥和
   模型目录的联通检查。界面只显示确实可用的模型下拉框，自动推荐其中的聊天模型，再执行最多
   1 token 的真实请求。只有实测成功才保存项目；切换下拉模型也会自动复测并保存，失败则保留原
   配置。以后从 ClaudeDock 启动该项目时会按需启动受管网关；切换到不需要它的直连/中转或 Codex
   CLI 后会自动停止，无需写 `~/.zshrc`、
   `~/.bashrc`、PowerShell 配置或系统级路由。
4. 如果当前项目已有 Claude Code 会话正在运行，托管接入会先终止该 PTY，避免安装或登录期间继续
   使用启动时的旧中转站并消耗额度；接入成功后以 `--continue` 在新路由恢复最近会话。接入或恢复
   失败时会话保持停止，不会静默退回旧路由。该切换只作用于当前项目；其他项目的后台会话仍保持
   各自的项目级配置。

`gpt-5.6-sol` 的 OpenAI API 模型规格允许约 105 万 token，但当前 Codex 产品会话配置使用
27.2 万原始窗口，并按 95% 留量显示约 25.84 万有效窗口。ClaudeDock 因而在底栏资源菜单提供：

- “标准”默认档：约 25.84 万有效窗口，在约 20.67 万时请求 Claude Code 自动压缩，避免等到
  200k/272k 边界后连压缩请求本身也被上游以 400 拒绝。
- “扩展（实验）”档：约 99.75 万有效窗口，在约 79.8 万时提前压缩。该档只对受管 ChatGPT 的
  `gpt-5.6-sol` 生效，并从下一次新建或重启会话开始使用；ChatGPT 订阅后端仍可能在 27.2 万附近
  拒绝，因此不是容量承诺。API 输入超过 27.2 万会进入更高计价区间，订阅额度如何计算仍以官方
  策略为准。更大窗口也不等于回答必然更聪明，长会话中早期信息的稳定利用需要按真实任务验证。

状态栏优先按 Claude Code 官方公式累加 `context_window.current_usage` 的当前输入与缓存 token，
只在这些字段缺失时才用取整后的百分比回退，因此不会再因 `used_percentage` 的粗粒度读数长期显示
100%。若上游仍返回 `Your input exceeds the context window`，ClaudeDock 会明确提示新建会话；
继续在已经溢出的会话里手动 `/compact` 不能保证恢复。

受管配置中的本地客户端密钥是 Claude Code 与 CLIProxyAPI 之间的随机访问密钥，不是 ChatGPT
凭据；项目配置副本用 Windows DPAPI 加密。CLIProxyAPI 自身必须在其权限受限的 `config.yaml` 中
读取客户端密钥和仅限本机的管理密钥，因此该受管文件包含本机明文副本。日常流程不会打开后台；只有
网关正在运行时，“高级设置”才允许打开本机管理页，并把管理密钥复制到剪贴板供用户粘贴登录。用户可
在界面中重新登录；上游发行版更新则在再次执行托管接入时下载和校验，不要求自行维护命令行工具。

受管下载继承 ClaudeDock“应用自身网络”作用域中的显式代理；未指定时继承 Windows 系统代理。
GitHub Release 会从 `github.com` 跳转到 `release-assets.githubusercontent.com`，下载器会用完整 URL
chain 认领同一任务，避免链式代理下 Electron 把最终地址报告为当前 URL 时误取消下载。ClaudeDock
只知道用户配置的第一跳，无法识别或改写代理软件内部的后续链路；后续节点仍需正确支持 HTTPS 与
Range 续传。网关的登录、解压和运行子进程会保留这些普通传输代理，但会清除继承的
`OPENAI_*`、`CODEX_*`、`ANTHROPIC_*`、CCR 等模型基址与凭据变量，确保上游只由 ClaudeDock
私有配置和专用 OAuth 目录决定。

### CCR CLI 自动路由与中断恢复

- OpenAI 协议上游需要格式转换时，ClaudeDock 自动决定使用 CCR，在后台以固定包名安装 CCR CLI、
  隐藏启动管理服务、读取上游实时模型、写入 Provider，然后主动启动并轮询确认 3456 模型接口，
  最后完成真实连接验证；普通用户不选择路由内核，也不操作 CCR 桌面安装器或管理页。
- 一键安装按“检查环境 → 下载 → 安装定位 → 校验 → 完成”实时更新按钮上方的状态卡和阶段进度；
  重复点击只等待同一个主进程任务。npm 官方源未完成时会显示原因并自动改用 npmmirror 重试。
- 安装会把不含 URL、代理、密钥或 Token 的最小阶段日志原子写入
  `userData/claude/router-operation.json`。断电或进程崩溃后，下次启动会幂等重跑 npm 安装、校验 CLI，
  成功后清除日志；失败则保留日志供下次重试，不清空 Provider、桌面版数据或 npm 缓存。
- 为 CLI 勾选的 ClaudeDock HTTP 应用代理会传给 npm；链式代理的后续跳仍由用户的代理软件负责。
  当前 CLI 会话切换到不需要 CCR 的直连/中转或 Codex 后，ClaudeDock 会停止自己管理的 CCR 后台。
- “高级设置”只有在 CCR CLI/ChatGPT 网关确实运行时才启用对应后台按钮；停止时按钮保持灰色，
  点击后台入口本身不会偷偷启动服务。

## 双通道安全更新

稳定版本同时发布到：

- GitHub Release：`https://github.com/AeonusOvO/claude-dock-control-panel/releases`
- 国内兜底镜像：`https://124.221.158.247/claudedock/windows/x64/`

每次发布只构建和签署一组 Windows 产物，再把完全相同的字节分发到两个通道：

- `ClaudeDock-Setup-<version>-x64.exe`
- `ClaudeDock-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `release-manifest.json`
- `release-manifest.sig`

客户端固定 Ed25519 发布公钥，分别验证每个通道的签名 manifest、版本、文件大小与 SHA-512；随后
对合格来源进行小范围真实 `Range` 下载测速并选择更快来源。GitHub 不可访问时，镜像不依赖 GitHub
元数据仍可独立验证。若两个在线通道声明不一致、发生版本回退、跨主机重定向、超大元数据、伪造
部分响应或完整安装包摘要不符，更新会失败关闭并保留当前可运行版本。

镜像只接受精确的 HTTPS 公网 IP，拒绝 HTTP、用户信息、query、fragment、未授权 IP 与跨主机
重定向。公网 IP 的受信任 TLS 证书并不规避备案、接入商政策或其他适用监管要求。腾讯云现行规则
明确要求仅通过公网 IP 提供的中国内地互联网信息服务办理 ICP 备案，但其备案系统暂不支持直接使用
IP 备案；在维护者从属地通信管理局取得可执行结论前，该地址只保留 TLS 与健康检查，不公开稳定安装
包。部署、原子切换、回滚和验收细节见 [docs/UPDATE_MIRROR.md](docs/UPDATE_MIRROR.md)。

## 开发环境

- Windows 10 1809 或更高版本
- Node.js 24 或更高版本
- npm 11 或更高版本

```powershell
npm install
npm run dev
```

完整本地门禁：

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:layout
npm run test:control-theme
npm run test:runtime-soak:accelerated
npm run build
npm run dist
```

其他针对性命令：

```powershell
npm run test:conpty
npm run test:release-security
npm run test:visual
npm run test:runtime-soak        # 默认 24 小时、无付费模型依赖的真实时间合成测试
npm run check:licenses
npm audit
```

`npm run dist` 将 Windows x64 产物写入 `outputs/`：

```text
outputs/ClaudeDock-Setup-<version>-x64.exe
outputs/ClaudeDock-Setup-<version>-x64.exe.blockmap
outputs/latest.yml
outputs/win-unpacked/
```

`outputs/`、`dist/` 与本地安装包不提交 Git。

## 发布流程

任何影响用户软件或发布配置的修改都要同步更新 `package.json` 与 `package-lock.json` 的 SemVer，
完成验证、功能分支、PR 和 `main` 合并后，才可从 `main` 创建与 package version 完全一致的
`v<version>` 标签。

`.github/workflows/release.yml` 会：

1. 核对标签、`main` 提交和 package version，并运行完整验证与依赖审计。
2. 在 Windows runner 上只构建一次，使用受信任证书签署应用、卸载器和安装器并验证 Windows 链。
3. 生成 Ed25519 签名 release manifest，先上传 GitHub draft Release 并回读校验。
4. 把同一组文件上传镜像的版本化 staging；全部验证后才原子公开稳定元数据。
5. 从两个通道重新执行 GET、HEAD、Range、大小、SHA-512、缓存头和 manifest 签名检查；任一失败
   都阻止稳定发布并回滚。

工作流 Secret 只保存独立镜像部署身份、manifest 私钥和代码签名凭据，任何私钥、Token、证书密码
或管理凭据都不得进入仓库、安装包或客户端源码。

### Code signing policy

完整的 [Code signing policy](CODE_SIGNING_POLICY.md) 记录团队角色、构建来源、逐版本人工批准、
事故响应和当前审批状态。SignPath Foundation 批准后采用其要求的公开归属语：Free code signing
provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/)。批准前的本地构建仍是未受信任签名的开发产物，不能据此
宣称正式签名已经完成。

## 目录

```text
assets/                  图标源与运行期公开配置
build/                   electron-builder / NSIS 自定义脚本
deploy/                  更新镜像的 Nginx、systemd 与部署脚本
docs/                    隐私、合规、镜像和发行说明
scripts/                 构建、许可、发布和验收脚本
src/main/                Electron 主进程与业务服务
src/preload/             受限 IPC 桥
src/renderer/            控制面板与终端界面
src/shared/              跨进程类型和纯函数
tests/                   单元、布局、主题与发布安全测试
outputs/                 本地安装包和解包产物（忽略）
```

## 安全与隐私要点

- 主窗口启用 `contextIsolation`、sandbox，关闭 renderer Node.js 集成；页面只加载项目内资源。
- Markdown 原始 HTML 不进入宿主 DOM；Artifact 需要用户显式运行并置于隔离 iframe。
- 自动更新拒绝降级、未签名 manifest、摘要不符和未经授权的下载主机。
- 项目秘密扫描覆盖当前工作树和完整 Git 历史；CI 也运行全历史扫描。
- 聊天历史和附件保存在当前 Windows 用户目录，属于本机明文可恢复数据；共享设备上应主动清理。
  历史更新使用同目录唯一临时文件和 Windows 短暂锁定重试，失败时不会先删除上一份有效历史。
- 本地构建默认没有可信代码签名，Windows SmartScreen 可能显示未知发布者；只有发布工作流的可信
  Authenticode 验证通过后才能发布稳定版。
- 当前只发布 Windows x64。

## 贡献与支持

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。一般问题使用
[GitHub Issues](https://github.com/AeonusOvO/claude-dock-control-panel/issues)，安全漏洞按
[SECURITY.md](SECURITY.md) 私密报告。

维护者：**AeonusOvO**；公开联系电话：**13585928550**。

## 开源许可

ClaudeDock 源代码按 [Apache License 2.0](LICENSE) 开放。第三方依赖保留各自许可；发行包包含
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)，维护规则见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
