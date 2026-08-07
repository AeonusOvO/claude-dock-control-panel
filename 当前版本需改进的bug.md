# 当前版本需改进的 bug

> 问题基线：ClaudeDock 4.6.0
> 文档维护版本：4.6.1
> 建档日期：2026-08-07
> 当前状态：讨论稿，尚未据此修改 UI 或架构

## 1. 文档目的与决策原则

本文把本轮反馈拆成“已确认缺陷、能力缺口、体验优化、需要进一步确认”四类，并记录候选方案、风险、
推荐方案和验收标准。涉及 UI、交互或架构的方案，必须先与用户确认，再进入实现。

统一遵循以下原则：

- 界面必须区分“用户请求的模式”和“运行时实际生效的能力”，不得把请求状态显示成已验证生效。
- 不伪造下载速度、剩余时间、模型能力或会话恢复结果；拿不到真实数据时应显示阶段和已用时间。
- 会话唯一性、恢复和任务状态先在主进程建立可靠数据模型，再让 renderer 展示，不能只做视觉去重。
- 终端仍是 Claude Code / Codex CLI 的宿主。ClaudeDock 可以控制 PTY、视口和渲染，但不能假设所有
  ANSI 真彩色都具有可安全重写的语义。
- 所有 UI 改动都要覆盖四套主题、最小窗口、不同缩放比例、键盘操作和减少动态效果模式。

## 2. 优先级总览

| 编号 | 问题                                   | 初步性质                   | 建议优先级 | 推荐方向                                      | 是否需先确认 |
| ---- | -------------------------------------- | -------------------------- | ---------- | --------------------------------------------- | ------------ |
| 1    | Ultra Code 显示与 X-High 实际档位      | 语义混淆、能力建模缺口     | P1         | 分离“工作流预设”和“实际思考档位”              | 是           |
| 2A   | 改变窗口大小后重影、截断、重复螃蟹图标 | 已确认的终端同步问题       | P1         | 自适应实时 resize + 最终权威重绘              | 是           |
| 2B   | 切换主题后终端部分背景不变             | 已确认的主题边界问题       | P1         | 调色板即时切换 + CLI 原生主题同步             | 是           |
| 3    | 崩溃后新对话能否进入历史               | 有条件可恢复、产品保障不足 | P1         | 小型原子恢复日志，与 Claude JSONL 对账        | 是           |
| 4    | 历史与进行中对话重复                   | 已确认，含并发写入风险     | **P0**     | conversation UUID 单一归属 + 事务化恢复       | 是           |
| 5    | 主题切换后历史右侧时间/UI 被遮挡       | 已确认的响应式布局脆弱点   | P1         | 固定操作列的三列网格，不做主题特判            | 是           |
| 6    | 图片无法粘贴/上传                      | 能力缺口与剪贴板兼容缺陷   | P2         | 补 Windows 粘贴并按 runtime/model 启用附件    | 是           |
| 7    | 后台任务提示失真、呈现方式冗余         | 已确认的状态派生缺陷       | P1         | Codex 式置顶摘要，服务进程与任务分离          | 是           |
| 8    | “伪终端会话已连接”信息不友好           | 解释与故障恢复缺口         | P2         | 成功静默，失败弹窗并提供针对性修复            | 是           |
| 9    | 更新时插件文案不清、长期转圈无进度     | 已确认的文案和进度缺口     | P1         | 分步骤、真实阶段/耗时；可取到字节时再显示速度 | 是           |
| 10   | GPT Fast 体感不快                      | 需测量；现有标签已过时     | P1         | 改为“GPT Fast（已请求）”并增加分段测速        | 是           |
| 11   | 不同模型的状态栏与思考档位不适配       | 架构能力缺口               | P1         | 统一 ModelCapabilityProfile，切模原子联动     | 是           |

P0 表示可能造成同一会话被多个进程同时恢复或写入，应先修；P1 是本轮主要质量问题；P2 可在核心
一致性完成后排期。

## 3. 各问题的调查结论与方案

### 3.1 Ultra Code 显示为 X-High

#### 已确认事实

- 当前 `src/shared/claude-effort.ts` 同时列出 `auto / low / medium / high / xhigh / max / ultracode`。
- `ultracode` 在现有实现里是“以 X-High 作为实际思考档位，再附加工作流编排”的请求预设；运行时
  status line 能报告的实际档位仍是 `xhigh`。因此“输入框上方 Ultra Code、底栏实际 X-High”不一定
  是切换失败，但目前的文案确实会让用户认为 Ultra Code 是比 X-High 更高的原生思考档位。
- renderer 当前优先用 `effortApplied` 覆盖 `effortRequest`，菜单勾选也依据 applied 值；所以实际
  `xhigh` 一到，Ultra Code 看起来会“跳回”X-High。这是确定的双源呈现 bug，不能只靠说明文案解决。
- Claude 官方当前把 effort 作为随模型变化的能力；不同模型支持的档位不同，未把 `ultracode` 列为
  通用 API effort。`ultrathink` 也只是单轮提示关键词，不能等同于新增 effort 档位。

#### 候选方案

**方案 A：保留单个菜单，显示双状态。** 菜单仍叫 Ultra Code，状态栏同时显示
“请求：Ultra Code；实际：X-High”。改动较小，但仍把两种不同概念放在同一菜单里。

**方案 B（推荐）：在 UI 上拆清“思考档位”和“工作流预设”。** 思考档位只展示模型实际支持的 effort；
工作流另设“标准 / Ultra Code”。但这只是概念和呈现分离：当前底层只有原子命令
`/effort ultracode`，选择 Ultra 仍会同时请求 X-High 和编排，不能组成“Low + Ultra”。关闭 Ultra 时恢复
用户此前明确选择的档位或模型默认值。模型不支持 X-High 时必须禁用 Ultra 并解释原因，不能静默降级。
`max` 和 `ultracode` 当前仅对本次会话有效，重新启动会话后必须按真实状态恢复显示，不能伪装成永久偏好。

**方案 C：把 Ultra Code 强制映射到最高原生档位。** 不推荐。不同模型的最高档位不一致，且会改变
现有预设语义，仍无法让 status line 报告一个并不存在的 `ultracode` effort。

#### 待确认

是否采用方案 B，并把现在的 Ultra Code 定义为 ClaudeDock 的“工作流预设”，而不是原生思考档位？

### 3.2 终端在窗口缩放时重影、截断和重复图标

#### 根因判断

ClaudeDock 使用 xterm.js 渲染、Windows ConPTY 承载 PowerShell/Claude Code。改变窗口大小时涉及
DOM 尺寸、xterm 字符网格、ConPTY 行列数和 Claude Code 全屏 TUI 重绘四个节拍。当前窗口 resize
使用 100ms 尾沿 debounce，内部栏拖动期间甚至完全跳过 fit；画布先被容器裁剪，松开后才跳到新网格。
此外，fit 会在行列未变化时仍发送 resize，冷启动测量还会连续重试，主进程也没有同尺寸去重；这会
让 Claude TUI 对同一尺寸重复整屏绘制。当前更可信的假设是：尺寸错位和重复 resize 让 TUI 在旧、
新坐标上重复写入终端缓冲，视觉上像旧帧与新帧叠加，表现为文字重复、橙色螃蟹框被截断或出现多个；
这仍需真实 Claude TUI 录屏和缓冲检查验证，不能先断言 xterm 在合成两张画布。普通 PowerShell 主要做行重排，Claude Code TUI
还会主动移动光标和整块重绘，所以不能仅靠缩短 debounce 就保证两者完全相同。

#### 候选方案

**方案 A：全程实时、应用端单次提交。** 用 `requestAnimationFrame` 合并窗口事件，每帧执行
`proposeDimensions → 行列去重 → xterm.resize + PTY resize`，只发送最新整数行列。现有 `terminal:size`
只是应用端归一化回执，不是 Windows/ConPTY 的真实 ack，不能等待一个不存在的系统确认；若需要防止
同一 PTY generation 内的迟到回执，还要新增独立 `resizeRevision`。这是最接近 PowerShell“一个字
一个字地缩”的基础方案。

**方案 B：拖动期间冻结画面，松开后一次重排。** 最能避免重影；结束时只做一次 fit/PTY resize 和
settle。xterm `refresh()` 只能重画现有缓冲，不能修复已经写错的单元；发送 `Ctrl+L` 又是 runtime 特定
输入，在忙碌、弹窗或有未提交输入时不能自动执行。稳定性最好，但拖动时不会逐字丝滑变化。

**方案 C（推荐）：分阶段混合。** 先把方案 A 作为所有终端的基础，并在 renderer/主进程双层做同尺寸
去重和唯一 settle；若已知当前是 Claude/Codex managed runtime 且真实回归仍复现，再启用可配置的
snapshot/mask 兜底，松开后提交最终尺寸。当前没有可靠信号自动识别所谓 redraw storm，alternate
buffer 也不等于 Claude/Codex，所以不能承诺无误判的自动切换。需要 CLI 完整重绘时只在安全门槛满足
或用户明确点击后执行。

#### 建议验收

- 连续拖动窗口 5 秒、快速来回改变宽度、最小宽度和 125%/150% 缩放下，重复行和重复螃蟹框均为 0。
- 最终 xterm 行列数、应用端归一化回执和当前 generation/resize revision 完全一致；不得把回执称为
  ConPTY 已确认，旧 revision 也不能覆盖新尺寸。
- PowerShell、Claude Code、Codex、中文宽字符、emoji、长代码块和滚动回看分别做压力测试。
- 若最终仍需 CLI 完整重绘，提供带安全条件的“重绘终端”操作；有 modal、后台任务或未提交输入时
  禁用并解释原因，而不是盲发 `Ctrl+L` 或让用户重启整个应用。

#### 待确认

建议选择方案 C。若必须把“拖动时始终逐字实时”放在第一位，则选择 A，但要接受更长的开发和回归周期。

### 3.3 切换主题后终端内容没有完整跟随

#### 已确认事实

当前主题切换会更新 ClaudeDock DOM 主题和 xterm 调色板，并调用 `refresh()`。现有 palette 能重映射
默认前/背景和 ANSI 0–15；ANSI 16–255 只有未来补充 `extendedAnsi` 后才能完整控制。Claude Code 的
代码修改背景、输入区域等可能使用固定 24-bit truecolor 或自身主题语义；已经写入的绝对 RGB 单元
不会因为调色板变化而自然变色。

因此，ClaudeDock 虽然取得了终端字节流和渲染视口控制权，却没有可靠掌握每个 ANSI 背景色的语义。
对所有 RGB 做字符串替换可能误改 diff 的增删颜色、代码语义色甚至用户程序输出。

#### 候选方案

**方案 A：只增强 xterm 调色板。** 切换最平滑、风险最低，但无法解决固定真彩色区域。

**方案 B：重写终端输出颜色。** 可强行统一外观，但需要长期维护一套脆弱的 ANSI 语义映射，存在
误改用户输出和未来 Claude Code 版本不兼容的风险，不推荐作为默认方案。

**方案 C（推荐）：混合原生同步。** ClaudeDock 外壳和 xterm 调色板立即切换；软件可控的
PowerShell 颜色尽量改用可重映射的索引色；新 CLI 会话从启动时就使用匹配主题。当前 Claude runtime
只在 launch settings 中写入主题，不能安全修改运行中的 Ink TUI。默认应提示“当前终端将在下次启动
生效”，并提供用户明确点击的“安全重载当前会话”；只有 runtime idle、无 modal、composer 为空且无
后台任务时才允许 restart/resume，提示必须可取消。`cli-idle` 本身不足以证明安全，resume 也不能恢复
live TUI、scrollback 或未发送输入。若未来 CLI 提供稳定结构化 live theme 接口再优先使用；旧
scrollback 的固定真彩色仍可能保持原样，界面必须如实说明。

#### 待确认

是否接受方案 C 的“新会话立即生效；运行中会话由用户明确点击安全重载”，以及一次可控闪动？

### 3.4 崩溃、断电后的对话历史与恢复

#### 当前行为

- `WorkspaceStore` 只持久化项目列表、最后活动项目和主题，不保存 live terminal、conversation UUID、
  PTY 或 xterm 缓冲。只有最后活动项目仍存在且可读时，重启才会为它新开普通 PowerShell 槽位；
  其他已记住项目仍只显示文件夹，任何项目都不会自动恢复原 Claude 进程。
- 历史的事实来源是 Claude Code 写入 `~/.claude/projects/<project>/<conversation-id>.jsonl` 的 transcript。
  若崩溃前已创建并写入非空 JSONL，ClaudeDock 重启后展开或显式刷新该项目历史时通常可以看到；
  残缺的最后一行会被忽略，前面的有效记录仍可读取。
- 若只是新建了终端，尚未生成 UUID JSONL、JSONL 仍为 0 byte，或者系统在 Claude Code 首次落盘前
  崩溃，就没有可恢复正文。未发送的输入、PTY 进程和屏幕画面也不能恢复。

#### 候选方案

**方案 A：继续只依赖 Claude JSONL。** 增加解释和刷新入口，工作量最小，但无法标记“上次异常中断”。

**方案 B（推荐）：增加最小恢复日志。** 使用权限受限、原子写入的 `workspace-recovery.json`，只保存
项目路径、conversation UUID、最后看到时间、显示顺序和 clean-shutdown 标记，不保存消息正文、Token、
PID 或终端画面。启动后与真实 JSONL 对账，显示“上次异常中断，可恢复”；由用户点击后再恢复，不静默
启动多个 CLI。没有 UUID/非空 transcript 的槽位只能标记为不可恢复，不能伪造历史。日志只能提高
异常会话的可发现性，不能补写 Claude 尚未落盘的正文，也不能保证找回仍在 OS/进程缓冲中的最后记录。
日志损坏时安全降级为空；启动时按 `(project, UUID)` 与真实 JSONL 去重并清除陈旧项；只有 runtime 和
workspace 都完成受控关闭后才能写 clean marker，不能在真正停止前提前标记为正常退出。

**方案 C：完整持久化 xterm/进程状态。** 不推荐。死掉的进程无法复活，缓冲体积、隐私、版本兼容和
恢复准确性成本都很高。

#### 待确认

是否采用方案 B；异常恢复提示是应用启动后只显示一次，还是一直保留到用户处理？推荐只显示一次并在
“项目与对话”保留一个可再次打开的中断标记。

### 3.5 历史对话与进行中对话重复

#### 已确认缺陷

当前 renderer 先渲染全部运行中会话，再无过滤地渲染全部磁盘历史；恢复成功后，同一 conversation
自然会出现两行。更严重的是：

1. renderer 的点击锁只覆盖一次 IPC 进行中阶段；调用完成后可再次点击同一历史。
2. 主进程没有保证“一个 `(project, conversation UUID)` 只能有一个 active/starting owner”，因此同一
   UUID 可以被两个真实 Claude runtime 并发尝试 `--resume`。Claude CLI 最终会加锁、分叉还是并发追加
   尚未经本轮实测；任何一种未定义行为都可能造成状态覆盖或历史损坏，必须按高风险阻断。
3. 历史恢复失败时，已创建的 workspace terminal 没有完整事务回滚，可能留下空的“历史 …”行。
4. 文件名派生的 `conversationId` 才是磁盘身份，但部分重命名/删除路径使用正文里的 `sessionId`；两者
   异常不一致时可能操作错误目标。

#### 必须先做的数据模型修复

- 唯一键固定为“规范化项目路径 + 小写的文件名 conversation UUID”，终端临时 ID 和标题不参与判重。
- 主进程保证单一 owner。点击已运行的历史时直接聚焦原终端；恢复正在启动时合并到同一请求。
- 精确恢复前就登记 UUID。应用发起的 `--continue`、原生 picker 等事前未知路径，在项目级持有一个
  provisional reservation，直到 UUID 上报或启动失败；已知为不同 UUID 的精确恢复仍可并行。
- 用户在原生 TUI 直接执行 `/resume` 无法事前拦截；status line 报告碰撞后必须先冻结新 owner 的输入，
  默认保留已有稳定 owner，并让用户选择“切换到已运行会话”或“替换旧 owner”，不能静默杀进程或让
  两个实例继续附着同一 transcript。
- 恢复事务失败时关闭精确的刚建 terminal，并恢复之前的选择；不能只清 runtime 状态。
- 历史列表的定向 restore、rename、delete 一律使用 filename-derived `conversationId`；新建、continue、
  picker 在 status line UUID 到达后再与 `<uuid>.jsonl` 对账。

#### 两种 UI 方案

**方案 A（推荐，单一归属）：** 只有存在 active/starting Claude owner 的 UUID 才从“历史对话”区移走，
只显示在“进行中”；runtime 退出到 PowerShell、失活、停止或关闭后立即回到历史。不能因为 terminal 行
还存在或 runtime 保留了用于 continue 的旧 ID，就把历史长期隐藏。用户看到的分类最清楚。

**方案 B（保留可见）：** 历史行继续存在，但标记“正在运行”，点击只聚焦原终端，禁止再次恢复。
信息连续，但同一对话仍会在两个区域出现，不完全符合本轮反馈。

#### 待确认

建议选择方案 A。这个选择只决定展示方式；无论选 A 或 B，主进程单一 owner 都必须实现。
发生原生 `/resume` 碰撞时，是否接受“默认保留已有会话；新实例冻结并提示切换/替换”？推荐接受。

### 3.6 主题切换后历史右侧时间和操作被遮挡

#### 根因判断

当前 `.project-list` 与 `.project-folder__history` 的右内距都是 4px，而 `design.md` 约定为 8px；两层
滚动区也没有连接历史已经使用的 `scrollbar-gutter: stable`。`.history-item` 缺少稳定的
`min-width: 0 / width: 100% / overflow` 约束，时间缺少 `nowrap` 和 tabular numerals，删除按钮又绝对
定位在另一布局层。这些是直接的布局脆弱点；四套主题字体/字重和滚动条度量变化只是让石墨主题更容易
触发遮挡，不应被写成唯一根因。对单一主题加 `right` 偏移会在其他缩放或翻译长度下复发。

#### 候选方案

**方案 A（推荐）：固定操作列的三列网格。** 使用“图标 / `minmax(0, 1fr)` 标题 / token/minmax 尾槽”，
时间文本与独立删除按钮在同一 grid-area 交叉淡入/淡出，不能嵌套 button；键盘 focus 时删除必须可达。
配合 8px 逻辑内距、`scrollbar-gutter: stable`、nowrap 和 tabular numerals。尾槽还要容纳 200% 缩放与
最长时间文本，不能写一个只对当前主题有效的魔法像素。

**方案 B：时间移到标题下方。** 最稳健但会增加每一行高度，历史列表密度下降。

**方案 C：只在悬停时显示右侧 UI。** 可减少常态宽度，但触屏和键盘可发现性较差，不推荐单独使用。

布局测试至少覆盖 270/320/560px 侧栏、滚动条有/无、四套主题、长标题、最长时间、200% 缩放和键盘焦点，
并用真实 bounding box 断言尾槽未被 clip，不能只检查静态 CSS 字符串。

#### 待确认

建议采用方案 A，并保持当前单行密度。若更重视完整时间可读性，可选择 B。

### 3.7 图片粘贴/上传缺口

#### 已确认事实

- “项目”页终端输入框只有文本，没有附件模型；Ctrl+V 只读文本，全局 drop 还可能把图片误当成要添加的
  项目目录。这是确定的能力缺口。
- 独立“对话”页已有附件存储、按钮、paste 和 drop，但 paste 目前只检查 `clipboardData.files`。
  某些 Windows 截图只出现在 `clipboardData.items` 或 Electron `clipboard.readImage()`，因此用户所说的
  “对话框无法粘贴”也可能发生在独立对话，需要真实复现并补兼容，不应过早缩小到项目终端。
- Claude Code 在 Windows 原生支持通过 `Alt+V` 从剪贴板粘贴图片，也支持拖放或提供图片路径；但
  Codex、第三方 provider 和具体模型的图像输入能力并不完全相同，所以不能对所有模型永久显示一个
  看似可用、实际无效的图片按钮。

#### 候选方案

**方案 A：先补独立对话的 Windows 剪贴板兼容。** 增加 `clipboardData.items/getAsFile()` 和受限的
`clipboard.readImage()` fallback、大小/MIME 检查与截图集成测试。它修复已有附件能力，但仍不解决项目终端。

**方案 B：项目终端只接 Claude 原生粘贴。** 检测到图片后转发 Claude Code 的 `Alt+V`，并让原生 TUI
显示 `[Image #N]` 作为单一事实来源；没有结构化 ack 时，ClaudeDock 不能先画“已附加”chip。上线较快，
但只覆盖 Claude Code。

**方案 C（推荐）：Runtime Attachment Adapter。** renderer 只展示附件和能力状态；主进程安全读取
剪贴板/选定文件并保存到受限临时目录；adapter 按 Claude、Codex、provider/model 能力选择原生图片粘贴、
结构化附件或路径回退。能力键至少包含 runtime、版本、平台、provider 和 model；切换模型时原子刷新
支持的 MIME、大小限制和入口状态。只有获得 runtime ingestion ack 后才能标记成功，否则由原生 TUI 呈现。

**路径回退：把临时图片路径拼进文本提示。** 通用但不够原生，可能遇到路径权限、沙箱和模型不读取文件
的问题，只适合作为明确标注的兼容回退。

临时文件必须限制权限，保留到明确 ingestion ack、会话结束或 TTL，再做崩溃孤儿 GC；只能删除应用副本，
绝不删除用户源文件。还要校验 MIME 魔数、文件/像素上限、SVG/恶意预览策略、junction/symlink 和规范化
路径；预览不能把路径或图片 base64 写入普通日志。路径回退必须验证 runtime sandbox 能读取该目录。

#### 待确认

首期范围建议只做“剪贴板图片 + 选择图片”，随后再加入 PDF/普通文件。请确认是否要首期一次覆盖
图片、PDF 和普通文件。

### 3.8 后台任务与“置顶摘要”

#### 已确认缺陷

当前活动条在“未完成任务数量大于 0”或“存在 web/sidecar 进程”任一条件满足时显示，但主文案始终按
“后台任务 N”生成。因此没有任务、只有服务进程时也可能显示“后台任务 0”或残留“正在运行”。部分
分支没有显式还原标题/说明，状态快照迟到时还会造成提示滞留。服务存活、正在执行的任务、等待用户、
失败和已完成摘要本来就是不同概念，不应混为一个旋转提示。

另一个状态源缺陷是：unfinished 任务目前不会自然超时，hook 在 `background_tasks=[]` 时又省略字段，
主进程无法把这个“权威空快照”用于清除漏掉 completion 的任务。进程异常或 hook 丢失后，提示可能
永久停留，必须同时修复事件字段存在性、空数组对账和孤立任务超时。

#### 候选方案

**方案 A：只修数量与显隐。** 没任务就隐藏；web/sidecar 单独作为诊断 chip。改动小，但仍没有用户可
回看的结果摘要。

**方案 B（推荐）：Codex 式紧凑置顶摘要。** 只在以下情况出现：有活动任务、等待用户、失败、刚完成
且有摘要，或用户手动置顶。常驻服务进程与任务分离，不驱动“正在运行”。摘要包括状态、来源会话、
最近进展和“打开 / 关闭摘要 / 清除已完成记录”；只有任务来源提供真实 cancellable command 时才显示
“取消”。无变化时不动画。main 提供可对账快照，renderer 不靠残留事件猜状态。

hook 在不同 Claude Code 版本上可能不完整，UI 应称“检测到的活动”；失联 unfinished 只能标记
“状态待确认/已失联”，不能伪装成成功完成。摘要必须是 xterm 之外的 overlay，不得写入 transcript。

**方案 C：完整跨项目任务中心。** 支持队列、历史、筛选和通知，能力最强，但信息架构和持久化范围较大，
适合后续版本。

#### 待确认

建议先做 B。任务完成后的摘要采用哪种生命周期：自动保留最近一条，还是只有用户手动置顶才保留？
推荐“自动保留最近一条，用户查看或关闭后消失”。

### 3.9 “Windows 终端伪终端会话连接”是什么

这是 ClaudeDock 与本机 PowerShell/Claude Code 之间的 **Windows ConPTY 本地终端连接**，不是互联网、
账号或模型 API 连接。它负责输入输出、终端行列大小和进程生命周期。

连接失败时，项目列表和一部分设置仍可打开，但项目终端、提示词发送以及 Claude Code/Codex CLI 会话
无法正常工作。当前成功状态长期显示“伪终端会话已连接”，占用了用户注意力；启动异常路径又丢弃了
原始错误，只给通用技术文案，所以现在还没有足够证据提供可信的“一键修复”。

#### 推荐方案

- 正常启动和已连接不显示技术文字，详细 ConPTY 状态只在诊断页可查。
- 连接超过合理时间或失败时显示主题一致的应用内弹窗：用户语言为“本地终端启动失败”，技术详情折叠。
- 主进程先保留并向 renderer 传递脱敏的 error category/code；主操作是“重试终端”。诊断可检查/重选
  不存在或不可读的工作目录、检查 PowerShell/ConPTY 条件，并只在证据充分时建议重装当前应用。
  OS 不支持、文件被安全软件隔离等情况不能放一个虚假的万能修复按钮。
- 弹窗要说明影响范围，并允许复制脱敏诊断信息；不在日志里泄露环境变量凭据。
- 弹窗按 session + generation 去重；用户主动停止终端时不弹。

#### 待确认

是否同意正常连接完全不显示文字，只在失败时弹窗？推荐同意；诊断页仍保留完整 ConPTY 状态。

### 3.10 更新界面的插件文案与进度

#### 已确认缺陷

- 插件市场刷新、更新、启用和停用等多类操作共用了“正在修改 Claude Code 插件”这一泛化 Busy 文案。
  “全部更新”会顺序更新 Claude Code 和插件，因此用户看到它并不一定是错误操作，但无法知道正在做哪一步。
- renderer 又把除卸载外的这些 Busy 操作统一显示成“安装中”，进一步丢失了刷新、更新、启用/停用等
  动作和目标插件。
- Claude Code 自更新可能交给原生 updater、未安装时的 WinGet 或 npm。当前命令执行会缓冲输出，退出后
  才返回最终结果，没有向 UI 流式提供过程遥测或总字节数，因而只显示无限转圈。ClaudeDock 的下载引擎
  虽然可显示速度和 ETA，但当前没有接管 npm 包下载阶段。

#### 候选方案

**方案 A（推荐的近期修复）：真实阶段进度。** 按实际选择的 native updater / WinGet / npm 动态生成
步骤，例如“检测安装方式 → 运行更新器 → 验证版本”，不能把“2/4”固化。插件显示具体名称和动作；
stdout/stderr 只有脱敏后才能流式展示或记录。上游没有总量时明确写“安装器未提供下载总量”，不显示
假的百分比、速度或 ETA。

**方案 B（后续增强）：受管下载。** 对 npm 路径由 DownloadEngine 获取顶层 tarball、校验 registry
integrity，再从本地包安装；只有这段顶层包传输可以展示真实字节、速度和 ETA。依赖解析、可选依赖、
生命周期脚本仍可能联网且没有可靠总量。方案会扩大供应链校验、缓存、代理和回滚架构，必须单独设计
和安全审计。

**方案 C：解析 npm 文本猜进度。** 不稳定且不能得出真实剩余时间，不推荐。

#### 待确认

建议先实施 A，并把 B 作为下一阶段。是否愿意为了真实速度/ETA 让 ClaudeDock 接管 npm 下载与完整性
校验？若暂不扩大架构，就只承诺阶段、日志和已用时间。

### 3.11 GPT Fast / “1.5X”体感速度

#### 已确认事实

- 当前状态栏把速度硬编码为“GPT 1.5x”，但 OpenAI 当前官方文档已把 Codex 的 Fast/Priority 描述为
  对受支持模型“最高约 2.5 倍”的模型推理加速；具体模型、额度、负载和服务层仍会影响结果。因此固定
  写“1.5x”已经不准确。这里的 2.5 倍只是 OpenAI 对官方 Fast 支持模型的上限描述，不是 ClaudeDock
  经兼容网关请求后的实测结果或当前会话保证，也不应显示成实时倍率。
- 当前受管 ChatGPT 路径只向兼容网关请求 `service_tier=fast`，无法从现有状态证明上游最终采用了该层级；
  所以“已请求”是准确表述，“已生效 1.5x”不是。
- Fast 主要缩短模型推理时间，不会加速 npm、构建、测试、文件扫描、网络工具或子任务排队。Ultra Code
  / X-High 会增加推理和工具步骤，整个任务的墙钟时间不一定更短。

#### 推荐方案

1. 菜单名只叫“GPT Fast”，旁边显示互斥状态“已请求 / 上游已确认 / 未生效”；只有响应返回可验证的
   actual service tier 时才能显示“上游已确认”。
2. 首期性能诊断只展示现有 hook 能可靠测到的 `UserPromptSubmit → Stop` 总耗时和已观测工具/后台阶段。
   xterm 首字节可能只是输入回显或 TUI 重绘，不能冒充首 token；TTFT、token/s、模型/网关等待拆分只有
   在网关或结构化 runtime telemetry 真正提供后才展示。
3. 在速度菜单解释“加速模型输出，不加速本地工具；高思考档位可能抵消总耗时收益”。
4. 若兼容网关无法回传实际 tier，永久保持 requested-only，不用 Claude 的 `fast_mode` 伪造 GPT 状态。
5. 标准/Fast A/B 诊断必须由用户显式触发，提示会消耗额度，并以多轮中位数而非单次结果作比较。

参考：[OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)。

#### 待确认

是否同意删除所有固定“1.5x”承诺，统一为“GPT Fast”，并用实测数据展示速度？推荐同意。

### 3.12 按模型适配状态栏、速度与思考档位

#### 当前问题

当前已经有 `model-speed-capabilities.ts` 速度能力骨架，会按 provider、model 和 CLIProxyAPI 版本
fail-closed，模型切换也会重算 speed signature，Codex 不可由 ClaudeDock 管理的控件会明确禁用。真正
缺口是 effort 仍用全局静态七档，附件、状态栏和未知/自定义模型没有统一、版本化的能力元数据与 revision。
因此一些控件仍会展示不受支持的选项，结果无效或被降级。不同厂商档位名称相似，也不代表能力相同。

#### 推荐架构：ModelCapabilityProfile

每个“runtime + provider + endpoint identity + model family + gateway/CLI version”解析为一个只读模型能力快照：

- `supportedEfforts`、`defaultEffort`、各档位显示名和实际请求值；
- `speedModes`、资格条件、是否能验证生效及状态来源；
- `inputModalities`、支持的附件 MIME/大小、上下文限制；
- 能力来源、发现时间和未知/过期状态。

permission/mode 和会话持久化更多属于 runtime/provider 能力，应由对应 profile 与模型能力合并成最终
`ModelControlState`，不能全部错误归因给模型。Codex 可新增 App Server adapter，管理其协议生命周期并
用 `model/list` 返回的 `supportedReasoningEfforts`、默认 effort 和 `inputModalities` 动态生成控件；这
不是当前已经接入的数据。Claude 使用官方版本化能力矩阵，并以 status line 作为实际状态证据；第三方
或未知模型默认关闭未经验证的能力，允许用户打开诊断而不是乐观猜测。

模型切换必须以一个 profile revision 原子更新底栏：模型名、速度、思考、附件和权限控件一起切换，
迟到的上一模型状态不能覆盖新选择。当前仍在使用但新模型不支持的选项，应先回到模型默认值并明确提示，
不能表面保留、实际无效。

参考：[Codex App Server `model/list`](https://learn.chatgpt.com/docs/app-server#list-models-modellist)、
[Claude effort 配置](https://code.claude.com/docs/en/model-config)、
[Claude Fast mode](https://code.claude.com/docs/en/fast-mode)。

#### UI 方案

**方案 A（推荐）：不支持项保留但禁用，并显示原因。** 用户能知道能力存在，只是当前模型不可用；
布局稳定，便于比较模型。

**方案 B：完全隐藏不支持项。** 更简洁，但模型切换时控件跳动明显，用户也难以理解选项为何消失。

文中“Fable 模型”的正式名称、供应商和 API 需要用户确认；在确认前不能凭名称建立能力规则。

#### 待确认

是否采用方案 A，以及“Fable”具体指哪个模型/服务商？

## 4. 建议的实施批次

### 第一批：会话正确性与可观测性

1. 问题 4：conversation UUID 单一 owner、恢复事务回滚、canonical ID 和历史展示。
2. 问题 3：异常恢复日志及启动对账。
3. 问题 10：去掉 1.5x 固定承诺，增加 requested/actual 和分段计时。

这一批先消除多进程写同一历史的风险，再改善恢复和速度判断。

### 第二批：终端视觉稳定性

1. 问题 2A：resize generation、权威尺寸确认和最终 redraw。
2. 问题 2B：主题混合同步。
3. 问题 5：历史操作列网格和跨主题布局测试。
4. 问题 8：ConPTY 成功静默、失败恢复弹窗。

这一批必须增加拖动录屏/截图基线以及四主题、不同 DPI 的自动化检查，不能只在默认主题肉眼验收。

### 第三批：模型能力与任务体验

1. 问题 11：ModelCapabilityProfile。
2. 问题 1：在统一能力模型上拆分 effort 与工作流预设。
3. 问题 6：Attachment Adapter。
4. 问题 7：置顶摘要。
5. 问题 9：阶段化更新；受管下载作为独立后续架构任务。

## 5. 需要用户确认的选项

可以直接按“`1B、2C、3C……`”回复；括号内是当前推荐：

1. Ultra Code：A 双状态，还是 **B 拆分工作流/思考档位（推荐）**？
2. 窗口缩放：A 始终实时，B 拖动冻结，还是 **C 自适应混合（推荐）**？
3. 终端主题：A 只改调色板，B 重写颜色，还是 **C 原生混合同步（推荐）**？
4. 异常恢复：A 只依赖 JSONL，还是 **B 最小恢复日志（推荐）**？
5. 进行中/历史：**A 运行时从历史移走（推荐）**，还是 B 保留并标记“正在运行”？
6. 历史行布局：**A 固定右侧操作槽（推荐）**，还是 B 时间另起一行？
7. 图片：独立对话先补 Windows 剪贴板兼容；项目终端选 B 只接 Claude 原生粘贴，还是
   **C Runtime Attachment Adapter（推荐）**？首期范围推荐只支持图片，之后再加 PDF/普通文件。
8. 任务摘要：**A 自动保留最近一条直到查看/关闭（推荐）**，还是 B 只保留手动置顶项？
9. ConPTY：是否同意“成功静默、失败弹窗 + 针对性修复”（推荐同意）？
10. 更新：是否先做真实阶段/已用时间，再把受管 npm 下载作为下一阶段（推荐同意）？
11. GPT 速度：是否删除固定“1.5x”，菜单只叫“GPT Fast”，另显互斥的实际状态（推荐同意）？
12. 模型选项：**A 禁用并解释不支持项（推荐）**，还是 B 隐藏；同时请确认“Fable”的准确名称。
13. 原生 `/resume` 碰撞：是否接受“默认保留已有 owner，新实例冻结并提示切换/替换”（推荐同意）？

## 6. 实现前必须补充的验证

- 会话：同 UUID 连点合并、已有 owner 只聚焦、恢复失败完整回滚、runtime 失活后重回历史、未知目标的
  项目级 provisional gate、原生 `/resume` 碰撞、filename UUID 与正文 sessionId 不一致、异常重启、
  0-byte JSONL，以及 recovery journal 的损坏/陈旧处理与 clean marker 写入时序。
- 终端：真实 Windows ConPTY 连续 resize、旧 generation 迟到事件、PowerShell/Claude/Codex、中文和
  emoji、最小窗口、125%/150% DPI、WebGL/context loss、完整 redraw。
- 主题与布局：四套主题逐一切换，270/320/560px 历史栏、滚动条、长标题、最长时间、200% 缩放、
  键盘焦点、减少动态效果和真实 bounding-box clip 断言。
- 能力联动：切换模型时上一 revision 迟到、未知模型、模型降级、requested/actual 不一致、附件能力变化。
- 更新与任务：0 任务但服务运行、事件丢失后快照对账、失败/取消/重试、无 Content-Length、npm 无进度输出。

## 7. 外部能力依据

- [Claude Code 会话存储与恢复](https://code.claude.com/docs/en/sessions)
- [Claude Code 交互模式、Windows 图片粘贴与完整重绘](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code Fast mode](https://code.claude.com/docs/en/fast-mode)
- [Claude Code 模型与 effort 配置](https://code.claude.com/docs/en/model-config)
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [Codex App Server 模型目录](https://learn.chatgpt.com/docs/app-server#list-models-modellist)

外部模型能力会随版本变化；进入实现和发布验收时必须重新核对官方文档，不能把本文件的时间点判断长期
硬编码为事实。
