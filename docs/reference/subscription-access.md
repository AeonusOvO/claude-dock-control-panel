# 订阅账号接入

核对日期：2026-08-28。本文记录实现与验证边界，不把存在登录入口当作付费账号已验收。
使用步骤见[接入模型](../how-to/connect-models.md)，普通 API 地址见[服务商接入参考](provider-access.md)。

## 能力与边界

| 入口                    | 授权方式                                                                  | Claude Code 上游                                                                                    | 状态与限制                                           |
| ----------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Kimi Code · 订阅        | 浏览器确认设备码，后台保管并刷新令牌                                      | `https://api.kimi.com/coding/v1/messages`                                                           | 使用 Kimi Code 权益；发送真实 ClaudeDock 客户端标识  |
| MiniMax · 订阅          | 国内 / 国际站独立的设备授权与 PKCE                                        | `https://api.minimaxi.com/anthropic/v1/messages` / `https://api.minimax.io/anthropic/v1/messages`   | 两个地域不混用凭据；要求账号有相应套餐权限           |
| GLM · 订阅（实验性）    | ZCode 浏览器授权；创建或复用名为 `claudedock-subscription` 的官方平台密钥 | `https://open.bigmodel.cn/api/anthropic/v1/messages` / `https://api.z.ai/api/anthropic/v1/messages` | 上游登录实现尚未合并；先查询套餐额度，再允许真实测试 |
| 千问 Coding Plan · 订阅 | 套餐密钥 `sk-sp-…`                                                        | 国内 / 国际 Coding Plan 专用入口                                                                    | 官方旧 OAuth 已停用；不提供失效的免密钥按钮          |
| 其他国内 API            | 用户自己的 API 密钥                                                       | 各服务商官方 API                                                                                    | 未经验证的网页登录态不作为订阅凭据导入               |

“订阅”标识套餐用途，不保证每个厂商都有免密钥授权。新账号入口不要求输入网址、协议或密钥；
“高级设置”中的“使用密钥”保留手动回退，旧的 GLM/Kimi 手动入口不在默认列表重复展示。编程套餐只能用于服务商允许的工具和场景；独立对话不提供
这些账号预设，也拒绝将托管订阅的本机地址当作普通 API。不同厂商或套餐不共享额度，不自动切换到按量 API。

GLM 官方说明：从未买过 Coding Plan 的账号调用 Anthropic 接口可能消耗余额。因此授权后必须使用最终密钥
查询同地域 `/api/monitor/usage/quota/limit`，取得有效的 `TOKENS_LIMIT` 窗口且未耗尽，才进入模型发现和测试。
响应未知、无套餐、额度耗尽或网络失败均停止，不把普通 API 调用成功当作订阅可用证明。该检查不是厂商计费承诺；
真实账号仍需在官方账单中确认套餐抵扣。

## 后台实现

新国内账号入口由 `src/main/subscriptions/` 内置转发服务处理，不安装或显示 CC Switch / CLIProxyAPI 窗口。
既有 ChatGPT 托管 CLIProxyAPI 链路保持独立。这里复用公开客户端的授权协议，不声称国内授权运行在其已发布二进制中，
也不写 CC Switch 数据库、接管系统 `zcode://` 关联或导入其他程序的令牌文件。

- Kimi 使用官方设备码端点，处理 pending、slow_down、过期和撤销；每次登录生成独立设备身份。
- MiniMax 校验 PKCE、随机 state、授权有效期和资源地域；令牌轮换沿用同一地域与公开客户端。
- GLM 国内使用本进程实际占有的随机回环端口与 state；国际站使用官方轮询流程。只有匹配的回调才能完成授权。
- 浏览器只打开 HTTPS 官方来源，拒绝 userinfo、未知来源和服务端重定向。账号密码、验证码和授权确认由用户在官网完成。
- GLM 只创建或复用 ClaudeDock 同名专用密钥；项目不唯一时要求手动选择密钥。不读取无关密钥、不重试创建 POST，
  不调用需要验证码的 ZCode 专属 mint 入口。取消或后续测试失败时，已在官网创建的专用密钥可能保留，用户可在官网撤销。

本机转发仅绑定 `127.0.0.1`，第一次实际占有 18520–18540 中的端口后持久化。重启时如果该端口被占用，
直接拒绝，不移动旧会话的地址，也不向占用端口的进程发送上游凭据。每次登录有独立随机 slot 和 256 位本机口令，
旧会话继续绑定原 slot；新登录不覆盖旧账号。

仅开放 Messages、count_tokens 和 models 路由，兼容 Claude SDK 的 `?beta=true`。校验 Host、Origin、路径和本机口令，
不透传客户端 Cookie、认证头或任意目标。上游固定为所选服务，使用原生 Anthropic JSON/SSE 与流式背压，不改写用户正文。
入口有请求体、并发、头部和超时上限；上游错误正文不返回给 renderer，不因限流或额度不足切换供应商。

浏览器授权及刷新使用 application 网络作用域，模型发现和推理使用 conversation 作用域；均经现有网络守卫，
守卫覆盖完整响应读取。禁止真实运行时的隔离 profile 不能启动真实账号授权。

## 凭据与事务

全部授权凭据由 Electron main 持有，保存于 userData 的 `managed-subscriptions/credentials.enc`。
整个文件使用 Windows `safeStorage` / DPAPI 加密；随机临时文件也只写密文，刷新后原子替换。
加密不可用、文件损坏、符号链接或超限时拒绝，不降级为明文存储，不覆盖无法读取的原文件。
DPAPI 不能防御已控制同一 Windows 用户会话的恶意程序，不作为系统级隔离承诺。

1. main 在打开浏览器前占有全局下个对话配置租约；ChatGPT 的全局安装授权事务也使用同一租约。
   普通 API 保存、清除、历史提升等写入不能插队。同一订阅重复点击共享一个 Promise，不同服务明确拒绝。
2. attempt UUID、取消信号和递增 revision 共同约束异步结果。取消必须携带精确 attempt，并等待旧操作退出后才释放租约；
   迟到授权、旧取消或旧渲染快照不能覆盖新状态。准备安装阶段和最终同步提交阶段不可取消。
3. 候选凭据先只驻留内存；发现模型并验证实际本机转发入口后，同步持久化候选并提交配置。失败保留原配置。
   凭据写入成功、配置写入失败时可能保留未使用 slot，但不会替换旧会话绑定。
4. 一个 slot 的并发请求共享一次刷新。某条请求断开不取消其他请求需要的轮换；刷新先保存新令牌再转发。
   上游 401 最多触发一次刷新重试，刷新或新令牌仍被拒绝后停止循环，要求重新登录。
5. 应用退出关闭准入、撤销授权轮询与本机 listener，并等待刷新清理；迟到结果不能写回凭据。
   刷新时磁盘保存失败会停止请求，可能需要重新授权，不承诺恢复已经轮换的旧 refresh token。

renderer 只取得阶段、通用提示、attempt、revision 和用户设备码。账号 access/refresh/device token、
GLM 平台令牌、授权 URL 与本机口令不经订阅 IPC 返回。成功配置视图只返回已脱敏的既有 ClaudeConfigView。
最多保存 128 个独立 slot；不自动删除旧 slot，以免使已有对话改绑或失效。撤销账号授权或专用密钥请在官网操作。

## 来源与验证

以下是协议依据，固定提交便于复核；上游后续修改不自动成为本项目行为：

- [Kimi 会员指南](https://www.kimi.com/help/kimi-code/membership-guide)；设备授权参考
  [CLIProxyAPI v7.2.144](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.144)，
  commit `d36b776c790a4d58027fd4fb434800fb5334bceb`。保留真实客户端标识，不伪装 Kimi CLI。
- [MiniMax 官方 OpenClaw 指南](https://platform.minimaxi.com/docs/token-plan/openclaw)与
  [OpenClaw MiniMax](https://docs.openclaw.ai/providers/minimax)；授权源码基线
  `openclaw/openclaw@629a47e3cc20a9f8b6d19c105f840b8a693ec4aa`。
  刷新协议另参考 `NousResearch/hermes-agent@99c3cad8570732202907cf71f971fea9ec57df26` 的 `hermes_cli/auth.py`；
  当前区域令牌交换与刷新使用相同 `/oauth2/token` 入口，尚未用付费账号验证刷新。
- [GLM ZCode 授权提案](https://github.com/router-for-me/CLIProxyAPI/pull/3928)，
  head `13c12c406955fa669024ef414f054e7255313174`，核对时仍未合并，不能称为已发布官方支持。
  [ZCode 接口与计费说明](https://zcode.z.ai/cn/docs/configuration)；套餐额度查询参考官方
  [zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins/blob/0446d0bb0bc537d97d3ab3664c4b8b9c4a0e1254/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)。
- [Qwen Code 认证](https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/auth/)：旧 OAuth 免费套餐于
  2026-04-15 停用，当前 Coding Plan 使用套餐密钥。不能通过旧代理教程恢复该授权方式。

无账号验证包括：HTTP 授权夹具、真实回环 callback/relay、重复点击、跨服务配置租约、取消和迟到响应、
SDK beta/模型路由、并发刷新、单请求断开、端口冲突、账号隔离、加密失败和退出。
真实 Electron 检查订阅/API 胶囊、无密钥登录界面与简洁说明，但不自动点击官网授权。
另已对 Kimi、MiniMax 两地域和 GLM 国际的匿名授权初始化做在线检查，返回字段与官方来源有效。
这些证据不等于已完成真实账号授权、套餐抵扣、长期刷新或全部 Claude Code 工具调用；仍需用户本人授权验收。

`work/` 中下载的上游研究源码不属于项目测试；Vitest 明确排除 `work/` 与 `outputs/`，避免把未安装依赖的第三方测试当作本仓回归。
