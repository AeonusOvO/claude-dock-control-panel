# 模型图标、额度与悬浮球

## 显示规则

活动栏“接入”改名为“模型”。未接入时使用模型图形；成功接入、切换及启动恢复后显示已保存平台的品牌图标。
中转站、自定义接口、OpenRouter 与 SiliconFlow 保留链路图标。表单草稿、失败测试、当前终端状态广播不改变全局图标。
地区、API 与订阅入口共用品牌；图标全部本地打包，加载失败回退为模型图形。

“下个对话接入”右边是额度/用量卡片，窄窗口换行。右侧按钮开启可拖动、始终置顶的悬浮球，
关闭按钮或卡片按钮可关闭；主窗口隐藏到托盘不关闭悬浮球，退出应用会关闭。下次启动不自动弹出。
两处显示同一份全局已接入模型的数据，不随当前查看的旧对话改变；不同账户不混合统计。

| 接入类型                | 数据来源和显示                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude 订阅             | 当前连接代次启动的 Claude Code 状态行上报的 5 小时/7 天 `rate_limits`；无上报时“暂无法获取”                     |
| ChatGPT 订阅            | 已安装 Codex App Server 的 `account/rateLimits/read`，必须与托管网关拥有的账户 email 一致，不另行登录或安装组件 |
| 其他订阅                | 没有已验证的稳定额度接口时“暂无法获取”，不把套餐名称、登录成功或上下文大小当作额度                              |
| API / 中转站 / 本地模型 | 最近一次成功接入后的已记录 Token；输入、输出、缓存读取、缓存写入分别累计，不估算余额或额度百分比                |

订阅圆环显示最紧的已知窗口剩余百分比；悬停查看两个窗口、重置时间和更新时间。旧数据明确标注。
API 初始显示 0 和“等待用量上报”；读取失败显示“暂无法获取”，已有统计则保留并标旧。

## Token 口径

- 仅统计 ClaudeDock 启动的 Claude Code 终端与原生对话（包括 subagent 记录）。独立对话配置互相独立，
  外部客户端、接入探测、没有上报的请求不纳入；数字不是平台账单。
- 成功保存或验证并保存才创建新统计代次与时间起点；仅测试、取消、失败回滚不清空。重新连接同一 API 也重新计数。
  应用重启/同一接入的启动恢复保留原时间起点和累计值。不同 API 账户或网址隔离，迟到消息由代次拒绝。
  首次升级到本功能且没有统计记录时，从首次启用时开始观察，不反推升级前的消耗。
- 每个 transcript 只计时间起点之后的 assistant `message.usage`，按稳定 message ID 去重；重复流式记录只补增长量。
  不使用 `context_window.total_input_tokens` 或上下文占用条推算累计使用量。
- `model-usage.json` 只保存不透明连接/来源摘要、代次、起点与 Token 数，不保存密钥、正文或请求头，不上传。
  文件损坏或不可恢复时开始新的观察期。

## 性能与安全

主进程复用既有状态行变化和原生 `usage.updated` 事件发出轻量信号，不增加终端输出处理、请求代理或逐 Token IPC。
单个懒启动 Worker 每 10 秒合并同文件信号，串行异步读取新增字节（64 KiB 分块），不在 UI/主进程解析历史。
新代次/应用重启最多重新扫描对应 transcript 一次；读取解析都在 Worker，历史记录按时间过滤。
每行最多 2 MiB、每来源最多 100,000 个去重 ID、Worker 堆上限 128 MiB；异常/超限标为不完整或旧数据，不阻断会话。
realpath 必须位于配置的 Claude projects 根目录，子代理文件必须位于对应会话的 subagents 目录。
订阅外部查询最多每 60 秒一次、singleflight，复用已有超时和账户缓存；两个窗口不各自轮询。
统计落盘异步合并，终端写入热路径无同步 I/O。启动时本地统计文件读取上限 1 MiB。

悬浮球用独立 `usage-widget.html`，不加载 xterm、Markdown 或历史，复用主题 token。
只有 `getModelUsage`、`setModelUsageFloating`、`onModelUsage` 三个白名单能力，无 `controlPanel`、任意 IPC、
Node、导航、弹窗或网络权限。只有两个用量频道接受拥有的悬浮球顶层 frame，其他频道仍只接受主窗口。

## 资源与验证

14 个品牌使用 15 个 SVG：Claude 官方一个、OpenAI 官方黑白两个，其余 12 个来自
[Lobe Icons 固定提交](https://github.com/lobehub/lobe-icons/tree/4aaf4ee1fb2678a7f989ea570f0f6ce14a9abf75/packages/static-svg/icons)，
MIT 授权保留于 `NOTICE`。SVG 注释记录来源与 SHA-256，打包门禁逐个校验字节，不接受任意 SVG。
Claude/OpenAI 官方资源保持原色；GLM、Kimi、MiMo、Ollama 的单色模型图标在深色主题反白。

`npm run test:model-usage` 在真实 Electron 中验证 Worker 统计、主线程延迟、四主题、受限 preload、
置顶与关闭/重开，生成 `dist/visual-qa/model-usage.json` 和截图。夹具不代表真实付费账户额度验收。
其余图标、接入事务、去重、时间边界、跨账户隔离、存储和渲染回归由 Vitest 覆盖。

官方依据：[Claude Code 状态行](https://code.claude.com/docs/en/statusline)、
[Agent SDK 用量](https://code.claude.com/docs/en/agent-sdk/cost-tracking)、
[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
