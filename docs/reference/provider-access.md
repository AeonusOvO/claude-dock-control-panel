# 服务商接入参考

文档核对日期：2026-08-27。以下覆盖本项目预设与主要国产开放平台，不代表所有厂商、地域或私有部署。
“有官方文档”不等于已用真实付费账号验证；实际可用模型、额度、地域与套餐限制以用户账号和实时响应为准。
默认界面不显示这些协议细节，只显示“可能会消耗少量 token”。

## 普通 API 与预设地址

| 服务                | 默认地址                                            | 认证与模型来源                                               | 官方依据                                                                                                                                                         |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek            | `https://api.deepseek.com/anthropic`                | Bearer；通过同站 `/models` 发现模型，文档模型作为后备        | [API 文档](https://api-docs.deepseek.com/)、[Coding Agents](https://api-docs.deepseek.com/guides/coding_agents/)                                                 |
| 千问 API（北京）    | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer，普通百炼 API Key；其他地域使用高级设置               | [OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)                                                                |
| 智谱 GLM API        | `https://open.bigmodel.cn/api/paas/v4`              | Bearer，普通 API Key；区别于 Coding Plan                     | [OpenAI 兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)                                                                                 |
| Kimi 开放平台       | `https://api.moonshot.cn/anthropic`                 | 开放平台 Key，不使用 Kimi Code 会员 Key                      | [Claude Code 接入](https://platform.kimi.com/docs/guide/claude-code-kimi)                                                                                        |
| MiniMax（国内）     | `https://api.minimaxi.com/anthropic`                | API Key；优先使用在线模型目录，普通 API 与套餐需核对密钥权限 | [文本生成](https://platform.minimaxi.com/docs/guides/text-generation)、[模型列表](https://platform.minimaxi.com/docs/api-reference/models/anthropic/list-models) |
| 火山方舟 API        | `https://ark.cn-beijing.volces.com/api/v3`          | Bearer；模型或推理接入点依账号发现，不编造通用部署 ID        | [API 接入](https://www.volcengine.com/docs/82379/1330626)                                                                                                        |
| 小米 MiMo           | `https://api.xiaomimimo.com/anthropic`              | Bearer；按量密钥与 Token Plan 密钥不同                       | [首次调用](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)、[Anthropic 接口](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api)           |
| 阶跃星辰 API        | `https://api.stepfun.com/v1`                        | Bearer；支持 `/models`                                       | [OpenAI 迁移](https://platform.stepfun.com/docs/zh/guides/developer/openai)、[模型列表](https://platform.stepfun.com/docs/zh/api-reference/models/list)          |
| 腾讯混元 / TokenHub | `https://tokenhub.tencentmaas.com/v1`               | Bearer；支持 `/models`，广州地域                             | [API 使用说明](https://cloud.tencent.com/document/product/1823/130078)、[旧混元平台迁移](https://cloud.tencent.com/document/product/1823/131382)                 |
| 百度千帆 / 文心     | `https://qianfan.baidubce.com/v2`                   | Bearer；目录不可用时使用官方快速开始的模型提示               | [快速开始](https://cloud.baidu.com/doc/qianfan/s/rmh4stn9m)                                                                                                      |
| 讯飞星火            | `https://spark-api-open.xf-yun.com/v1`              | Bearer 中填 HTTP 接口的 APIPassword，非控制台其他 Secret     | [HTTP 文档](https://www.xfyun.cn/doc/spark/HTTP调用文档.html)                                                                                                    |
| 硅基流动            | `https://api.siliconflow.cn`                        | Anthropic 兼容入口；自动识别 x-api-key / Bearer              | [Claude Code](https://docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-ClaudeCode)、[普通 API](https://docs.siliconflow.cn/cn/userguide/quickstart)        |

国际 GLM、千问与 MiniMax 保留独立预设，密钥不在国内/国际地域之间自动转发。腾讯旧混元售卖入口正在迁移，
新增预设使用 TokenHub，不自动把旧平台密钥迁移到新平台。

百川仍提供[公开 API 文档](https://platform.baichuan-ai.com/docs/api)，但本文未确认其全部模型的最小生成上限与
在线发现行为，暂不新增“只填密钥”的自动预设，可以使用高级自定义。零一万物
[开放平台公告](https://platform.lingyiwanwu.com/)说明逐步停止在线体验、API 与充值服务，不新增 Yi 默认入口。
需要企业 IAM、签名或独立部署地址的平台不推断通用网址，也不承诺只填一个 API Key 即可使用。

## 官方订阅与 CLI

| 套餐                    | 已公开的接入方式                                                                                                                       | 本项目边界                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 千问 / 百炼 Coding Plan | `sk-sp-` 套餐密钥；Anthropic `https://coding.dashscope.aliyuncs.com/apps/anthropic`，OpenAI `https://coding.dashscope.aliyuncs.com/v1` | “接入”页供 Claude Code 使用，普通 API 独立预设；不转发套餐 Key 到按量接口 |
| GLM Coding Plan         | 套餐 API Key；Anthropic `https://open.bigmodel.cn/api/anthropic`，OpenAI `https://open.bigmodel.cn/api/coding/paas/v4`                 | 仅用于官方支持的工具，不把套餐当作自建聊天后端                            |
| Kimi Code 会员          | 官方 CLI 登录或会员控制台 Key；Anthropic `https://api.kimi.com/coding/`                                                                | 使用会员预设供编程工具接入；不伪造 User-Agent、不抽取网页令牌             |
| 火山方舟 Coding Plan    | 专用密钥与 `https://ark.cn-beijing.volces.com/api/coding`                                                                              | 与普通方舟 API 分开                                                       |
| 阶跃星辰 Step Plan      | 专用套餐与 `https://api.stepfun.com/step_plan`                                                                                         | 与普通 StepFun API 分开                                                   |

千问当前官方文档明确：**Qwen OAuth 已于 2026-04-15 停用**；新配置使用 Alibaba Cloud ModelStudio
Coding Plan、Token Plan 或 Standard API Key，不能照搬旧 OAuth 教程。见
[Qwen Code 认证](https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/auth/)。
百炼列出支持的工具，但限制自建后台与非交互批量 API 用途，见[套餐说明](https://help.aliyun.com/zh/model-studio/coding-plan)。
GLM 也明确限制官方支持工具，见[快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)与
[套餐概览](https://docs.bigmodel.cn/cn/coding-plan/overview)。因此“CLI 能用”不能推导出任意代理/自建应用都可复用订阅。

Kimi 要求第三方保留真实客户端标识，见[会员使用指南](https://www.kimi.com/help/kimi-code/membership-guide)。
火山与阶跃的套餐入口分别见[方舟 Coding Plan](https://www.volcengine.com/article/37538)与
[Step Plan](https://platform.stepfun.com/docs/zh/step-plan/quick-start)。MiniMax 与 MiMo 的普通 API/Token Plan
存在相同域名，单靠 URL 不能推断套餐权限；独立对话应使用符合用途的 API 密钥，不声称自动识别全部套餐。

已有 ChatGPT 订阅链路保持独立。官方 Codex 支持 ChatGPT 登录，但这不等于普通 OpenAI API 额度，见
[Codex 认证](https://developers.openai.com/codex/auth)。本次不新增网页登录态抓取或第三方订阅令牌迁移。

## 自动探测与安全边界

1. main 重验地址；远程补 `https://`，仅回环可用 HTTP。不自动降级远程明文，不接受 URL 中的密钥、查询或片段。
2. 同源尝试模型目录（最多 6 次、每次 4 秒）；预设或同一已保存接入的模型作为后备。未知中转无目录时要求高级设置，
   不使用隐藏的 `default` 或伪造模型 ID。
3. 最多尝试 3 个文本模型，按候选地址逐一验证 Anthropic Messages、OpenAI Chat Completions、Responses 与认证方式。
   在尝试下个模型前先覆盖各协议；每个请求只发送 `.`，无对话历史、系统提示、附件或工具。有效响应后立即停止。
4. 自动探测最多 12 次生成请求、总计 60 秒。Messages/Chat 输出上限从 1 开始；Responses 从 16 开始；仅在服务端
   明确拒绝参数时做有上限的兼容调整（最多 64）。实际计费包含输入、输出、推理及厂商规则，**不保证总共 5 token**。
5. 自动探测不跟随重定向、不跨站或跨地域尝试密钥。更换域名、端口或租户路径须重新填密钥；只在等价路径复用加密凭据。
   额度不足或限流立即结束。HTML、错误 envelope 与只有 HTTP 200 的返回均不算成功。
6. 独立对话的探测复用真实聊天的 conversation fetch/网络授权；Claude 接入使用 application 授权。官方网络拒绝不可通过
   换路径或协议绕过。错误与结果不回传密钥、认证头或请求正文。
7. 成功后 main 才原子保存；“测试连接”不保存。Claude 的 OpenAI 源还需准备本地 Router 并验证转换后的入口，失败回滚。
   原生 Anthropic 已通过的探针不重复发送。直连探针证明端点、认证与模型响应，不证明全部 CLI 工具行为。

Responses 聊天使用 stateless `input` 与 `store: false`，支持正文、推理摘要、拒绝、完成/失败事件与 usage；历史消息按
[官方输入 schema](https://developers.openai.com/api/reference/typescript/resources/responses)序列化。

## 不花付费额度的回归

`tests/main/automatic-connection.test.ts` 既有 fetch 夹具，也通过真实回环 HTTP 服务覆盖三种协议。
事务、认证隔离、对话协议与界面切换分别由 Claude next-connection、chat config/IPC、Responses 与 renderer 测试覆盖。
这些测试不读取用户账号、不调用付费服务；真实服务验收仍需用户本人密钥与合法套餐权限。
