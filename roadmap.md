# ClaudeDock 产品路线图

本文件记录本轮三项产品任务的实施结论、边界与后续演进项。已上线行为以
`README.md`、`design.md`、`technical.md` 和可验证代码为准。

## 状态与建议顺序

| 编号 | 任务               | 状态         | 建议实施顺序 |
| ---- | ------------------ | ------------ | ------------ |
| 1    | 历史对话删除       | 已实现并验证 | 1            |
| 2    | 独立“对话”选项卡   | 已实现并增强 | 3            |
| 3    | 全局设置入口与分类 | 已实现首期   | 2            |

实际按“历史删除 → 全局设置外壳 → 独立对话”完成。独立模型配置使用自己的
`chat-profile.json` 与安全存储边界，没有与 Claude Code 的项目级接入配置强绑定。

## 任务一：历史对话删除

### 目标

在“项目与对话”的每一条历史对话上提供可见、键盘可达的删除入口，并优先调用 Claude Code
正式提供的单会话删除能力。删除是永久操作，必须二次确认。

### 实施结论

- 左侧历史项已增加可见 `×` 和右键“删除历史对话”，两者调用同一永久删除确认。
- preload 和主进程的 `deleteClaudeSession` / `claude:delete-session` 已改为传递项目路径
  与 UUID，因此记住但未打开终端的项目也能定向删除历史。
- `ClaudeSessionManager.deleteSession()` 会直接删除当前项目目录下经 UUID 校验的
  `<session-id>.jsonl`；这不是“调用 Claude Code 自带删除功能”，界面与文档不作该宣称。
- 本机 Claude Code 2.1.220 的公开 CLI 没有删除单个本地会话的命令。官方 `/resume` 选择器
  文档列出了恢复、预览和重命名，但没有删除快捷键。`claude project purge` 会删除整个项目的
  transcripts、tasks、file history 和配置记录，范围远大于本任务，禁止用于单条历史对话。
- Claude Code 官方 VS Code 界面已经提供历史会话的 remove 操作，说明产品层存在单会话移除
  语义，但实施前仍需确认 ClaudeDock 可稳定调用的正式接口。

### 实现约束

1. 已针对当前验证版本核对公开能力；后续 Claude Code 若提供稳定单会话删除 API/CLI，应优先
   换成结构化调用，不拼接 shell 字符串。
2. 不得用 `claude project purge` 代替单会话删除，不得依赖未文档化的 TUI 坐标或盲发按键。
3. 当前继续采用“严格验证后删除 JSONL”的兼容方案；不得把兼容方案描述成 Claude Code 官方 API。
4. 删除目标必须同时绑定规范化项目路径和合法 UUID，主进程重新校验后才执行。不得接受 renderer
   提供的任意文件路径。
5. 如果同一 Claude conversation 正在 ClaudeDock 中运行，确认文案必须说明会先终止对应终端；
   只有终端停止并解除占用后才删除，避免留下仍向已删除 transcript 写入的进程。
6. 使用现有应用内 `<dialog>` 二次确认，明确提示“永久删除、无法恢复”。不使用
   `window.confirm`。

### 交互与验收

- 每条历史项在悬停、聚焦时显示删除图标，右键菜单同时提供“删除对话”；两处调用同一动作。
- 删除按钮具有包含对话名称的 `aria-label`，危险操作使用项目既有红色语义样式。
- 取消确认不修改任何状态；确认后成功删除目标、刷新该文件夹历史并保留合理的滚动位置。
- 成功 toast 包含被删除的对话名称；失败保留原条目并显示可读原因，不静默吞错。
- 不影响其他项目、其他历史会话、接入历史或运行中的无关 PowerShell。
- 单元测试覆盖项目路径/UUID 校验、跨项目拒绝、运行中会话处理、取消、失败与成功刷新；
  renderer 交互测试覆盖可见入口、右键入口、应用内确认框和键盘可达性。

## 任务二：新增独立“对话”选项卡

### 目标

在顶级导航中新增“对话”选项卡，提供不依赖 Claude Code/PowerShell 的通用模型聊天界面。
它可以直连模型 API，也可以连接兼容中转；模型、接口、认证和会话参数独立配置，不要求与
现有“接入”页使用相同模型。

### 产品边界

- “项目”继续承载项目目录、PowerShell 和 Claude Code 编程会话；“对话”是独立的通用聊天
  场景，不读取当前项目文件，不复用 Claude Code session，也不启动 PTY。
- 对话配置使用独立的 profile/store 命名空间。可以提供“从接入配置复制”作为显式便捷动作，
  但复制后形成独立快照；之后任一侧修改都不得暗中联动。
- 首期至少支持 Anthropic Messages 与 OpenAI Chat Completions 两类常见协议，以“协议适配器”
  区分接口能力，而不是仅凭 URL 猜测。OpenAI Responses 等协议在有明确需求后追加。
- 远程端点只允许 HTTPS，本机回环地址可以使用 HTTP；URL 不允许携带用户名、密码、查询参数
  或片段。
- API Key/Token 只在 Electron 主进程中通过 `safeStorage` 保存和读取。renderer 只能获得
  “是否已配置凭据”，不得回读明文。

### 最小功能范围

- 顶级活动栏最上方出现“对话”，有明确图标、可读名称、选中态与键盘焦点；“项目 / 接入”
  保持相邻。
- 首次使用显示配置引导：协议、接口地址、认证方式、模型名称和可选自定义模型。
- 聊天区包含消息列表、多行输入、发送、流式输出、停止生成、新建对话和清空
  当前显示；IME、`Enter`/`Shift+Enter` 与减少动态效果行为保持现有设计规范。
- 模型选择以独立对话配置为准，允许填写服务商目录之外的合法模型标识。
- 请求由主进程发起，支持取消和超时；HTTP 错误保留状态码和净化后的服务端说明，中转非标准
  响应给出可恢复错误，不把密钥写入日志或 renderer 事件。
- 对话历史已选择“有限本机持久化”：正文与 Token 快照明文保存到
  `userData/claude/chat-history.json`，最多 50 个对话、每个 100 条消息，支持逐条确认删除。
  凭据仍由 `safeStorage` 加密且不进入历史文件。后续仍需补保留周期、一键清空和可选禁用历史。
- 工具栏实时展示上下文与输入/输出 Token；输入草稿和无 usage 接口使用明确标注的估算值，
  供应商返回 usage 后切换为精确值。独立接入表单提供不保存草稿的 1-token 连接测试。

### 验收

- “对话”使用模型 A、“接入”使用模型 B 时，两边可以同时工作且互不改写配置。
- 修改、删除或测试独立对话 profile 不改变任何项目的 Claude Code 接入配置。
- Anthropic 直连形态和 OpenAI 兼容中转各有可替换 HTTP 测试夹具；停止通过 AbortController
  终止请求。
- 无凭据、HTTP 错误、超时和畸形流式响应进入明确、可恢复的界面状态；更细的 429/模型不存在
  专用动作可随服务商目录演进。
- 窄窗口、键盘操作、屏幕阅读器名称和 `prefers-reduced-motion` 纳入布局与交互测试。

## 任务三：全局设置入口与分类

### 入口与导航

- 在软件左下角增加常驻齿轮入口“全局设置”，与上方业务活动栏分组，不随当前活动页收起。
- 全局设置采用独立设置面板和内部分类导航。首期只创建有真实内容的“总设置”和“接入”两类，
  不预先生成空页面。
- 打开、关闭和切换分类不停止终端或模型请求；关闭后恢复原焦点。820×640 最小窗口必须完整
  可操作。

### “总设置”首期内容

1. **开机启动**：使用 Windows 登录项能力，保存实际状态；失败时回滚开关并显示原因。
2. **主题**：复用现有主题单一事实来源。现有终端工具栏主题选择器若保留，只作为快捷入口，
   与全局设置读取和写入同一配置，不维护两份状态。
3. **语言**：显示当前界面语言并为后续语言包保留结构。只展示真正可用的语言，不提供无法
   生效的伪选项；语言变化需要重启时明确提示。
4. **当前版本**：从打包应用实际版本读取，不手写常量；统一“检查更新”仍使用标题栏已有入口。
5. **常规行为**：建议同页纳入“关闭窗口后驻留托盘”和“启动后恢复上次页面”等真正全局的
   桌面行为。没有实现的选项不占位。

### “接入”首期内容

- 删除目前“接入”页中的“打开高级设置”入口；服务商选择、凭据/模型表单、测试和接入历史
  仍留在原主流程。
- 将现有高级设置的认证来源、自动发现、手动配置、Router 管理、cURL 识别、转换器说明和
  诊断工具整体移动到“全局设置 → 接入”，不复制 DOM 或维护第二套状态。
- 这些工具同时包含全局能力和项目级能力，界面必须显式区分作用域：
  - Router 安装/版本、管理服务、网关检测和通用诊断属于本机全局；
  - 认证来源、当前项目接入草稿、Provider“用于当前项目”等操作属于所选项目。
- 有活动项目时显示当前项目名称/路径；没有项目时，全局 Router/诊断仍可使用，项目级字段
  禁用并解释“请先打开项目”，不得把配置静默写到最近项目或用户目录。
- 原高级设置“完成/取消”的草稿快照语义继续有效；安装、卸载、启停、Provider 保存等即时
  操作仍明确提示不可随“取消”回滚。

### 同类软件设置分类调研与建议

官方资料显示，成熟桌面 AI/开发工具通常把全局行为、外观、能力/连接、数据控制、通知和
高级项分开：Claude 使用 General、Appearance、Capabilities、Extensions 等入口；ChatGPT
单列 Data Controls；VS Code 区分全局 User 与项目 Workspace 作用域，并把 accessibility、
workspace trust 和 advanced 作为可筛选类别；Windows 也长期将系统、个性化、应用、语言、
辅助功能、隐私安全和更新分开。

结合 ClaudeDock 当前功能密度，建议使用以下演进分类：

| 分类           | 首期                         | 适合承载                                               |
| -------------- | ---------------------------- | ------------------------------------------------------ |
| 总设置         | 是                           | 开机启动、主题、语言、托盘行为、版本与更新             |
| 接入           | 是                           | API/中转、认证、Router、cURL、网络诊断与项目作用域提示 |
| 对话与模型     | 功能增长后再拆               | 独立聊天默认模型、系统提示、生成参数、历史保留         |
| 终端与项目     | 功能增长后再拆               | 默认 shell、终端行为、项目恢复与工作区偏好             |
| 通知           | 有系统通知后再拆             | 完成、错误、后台任务、声音和免打扰                     |
| 隐私与数据     | 历史已有限持久化，待独立成页 | 凭据说明、会话保留、导出/清除、日志和遥测              |
| 辅助功能与外观 | 选项增多后从总设置拆出       | 字体、对比度、减少动态效果和屏幕阅读器选项             |
| 高级与诊断     | 专用项增多后从接入拆出       | 日志、重置、实验功能和故障诊断                         |

“关于/更新”在只有版本与检查更新时留在“总设置”；内容增多后再独立。这样首期不会出现只有
一两个控件的碎片页，也为任务二和后续隐私需求留下稳定位置。

### 验收

- 左下角“全局设置”在对话、项目、接入、插件页以及侧栏收起状态下都可达。
- 原“接入”页不再出现高级设置入口，全部原功能在“全局设置 → 接入”可找到且只有一套实现。
- 开机启动和主题重启应用后保持；语言只展示当前真正可用的简体中文；版本取值与
  `app.getVersion()`/安装包版本一致。
- 没有活动项目时不会误写项目配置；切换项目后项目作用域标识和草稿同步更新。
- 分类切换、模态/面板焦点、最小窗口布局、ARIA、减少动态效果和全局主题纳入自动化及视觉
  检查。

## 外部依据

- Claude 官方 MCP Apps 视觉令牌与排版规范：
  <https://claude.com/docs/connectors/building/mcp-apps/design-guidelines>
- Claude 官方透明主题规范：
  <https://claude.com/docs/connectors/building/mcp-apps/transparent-theming>
- Telegram Desktop 与 Telegram Web A（Open Sans、明亮主题与动效令牌）：
  <https://github.com/telegramdesktop/tdesktop>、
  <https://github.com/Ajaxy/telegram-tt>
- Open Sans 与 Fontsource 字体来源：
  <https://github.com/googlefonts/opensans>、
  <https://github.com/fontsource/font-files>
- Claude Code 会话管理（CLI `/resume`、命名、存储与保留）：
  <https://code.claude.com/docs/en/sessions>
- Claude Code VS Code 历史会话的 rename/remove 入口：
  <https://code.claude.com/docs/en/ide-integrations>
- Claude Desktop 的 General 设置示例：
  <https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork>
- Claude 的 Appearance 设置：
  <https://support.claude.com/en/articles/8887527-customizing-your-appearance-settings>
- Claude 的 Capabilities 设置：
  <https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude>
- ChatGPT Data Controls：
  <https://help.openai.com/en/articles/7730893-how-do-i-view-my-chat-history>
- VS Code 的 User/Workspace 设置作用域与高级设置：
  <https://code.visualstudio.com/docs/configure/settings>
- Windows 设置分类与应用启动项：
  <https://support.microsoft.com/en-US/Windows/Experience/exploring-windows-settings>
- Windows 应用设置页设计指南（底部入口、相关分组、少而即时生效）：
  <https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings>
- Windows 通知设置：
  <https://support.microsoft.com/en-US/Windows/Experience/notifications-and-do-not-disturb-in-windows>

## 维护规则

- 开始实现任一任务时，将对应状态改为“进行中”，并在分支/PR 中引用任务编号。
- 功能通过规定验证并发布后，将状态改为“已完成”，把已上线事实同步到 README、design 和
  technical；路线图只保留关键决策与未完成后续项。
- 调研日期为 2026-07-28。Claude Code 或同类产品能力变化后，应重新核对官方资料，尤其是
  单会话删除接口与设置分类。
