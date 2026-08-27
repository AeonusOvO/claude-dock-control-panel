# 文档

按 [Diátaxis](https://diataxis.fr/) 四分：解释为什么、参考查事实、指南照着做、决策记录留依据。

## explanation —— 为什么这样设计

| 文档                                           | 内容                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| [architecture.md](explanation/architecture.md) | 进程边界、分层依据、状态所有权、数据流、外部进程、构建 |
| [design.md](explanation/design.md)             | 设计系统与交互约束                                     |

## reference —— 查事实

| 文档                                                       | 内容                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| [technical.md](reference/technical.md)                     | 各功能域的实现细节、接线与技术约束                        |
| [project-layout.md](reference/project-layout.md)           | 目录结构、依赖规则、文件体积护栏                          |
| [ipc-contract.md](reference/ipc-contract.md)               | 全部 212 个通道与 `ControlPanelApi` 212 个 API 成员的映射 |
| [cli-command-catalog.md](reference/cli-command-catalog.md) | Claude / Codex 斜杠命令清单                               |

## how-to —— 照着做

| 文档                            | 内容                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| [develop.md](how-to/develop.md) | 环境、命令、加 IPC 往返 / 状态广播 / 设置项 / 视图样式、约定 |
| [verify.md](how-to/verify.md)   | 快门禁、全门禁、发布报告、COS 公开 feed 验收                 |
| [release.md](how-to/release.md) | 通道产物、COS 发布、控制台备用、引导与信任边界               |

## adr —— 决策记录

| 编号                                                       | 决策                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| [0001](adr/0001-three-process-boundary.md)                 | 三进程边界与 shared 层纯度               |
| [0002](adr/0002-typed-ipc-contract.md)                     | 单一类型化 IPC 契约                      |
| [0003](adr/0003-source-text-regression-pins.md)            | 源码文本回归钉                           |
| [0004](adr/0004-local-first-renderer-assets.md)            | 渲染端资源本地优先                       |
| [0005](adr/0005-native-select-as-source-of-truth.md)       | 原生 `<select>` 保留为事实源，只替换呈现 |
| [0006](adr/0006-feature-sliced-renderer.md)                | 按特性分片的渲染进程结构                 |
| [0007](adr/0007-single-release-directory.md)               | 单一发布目录与 COS 更新链                |
| [0008](adr/0008-ipc-single-source-of-truth.md)             | IPC 通道与载荷的单一事实源               |
| [0009](adr/0009-behavioral-tests-replace-source-pins.md)   | 行为测试替代源码文本钉（取代 0003）      |
| [0010](adr/0010-runtime-registry-and-contributions.md)     | 运行期注册表与贡献点                     |
| [0011](adr/0011-registration-based-feature-composition.md) | 渲染端注册式分片                         |
| [0012](adr/0012-scroll-chaining-and-canonical-scrim.md)    | 单一滚动链与规范遮罩                     |
| [0013](adr/0013-versioned-workspace-onboarding.md)         | 版本化工作区启动引导                     |
| [0014](adr/0014-independent-engine-model-access-wizard.md) | 引擎/模型解耦与可中断接入向导            |
| [0015](adr/0015-classified-connection-history.md)          | 来源筛选与分类接入历史                   |
| [0016](adr/0016-confirmed-tested-history-replay.md)        | 先确认、实测后提交的历史接入事务         |
| [0017](adr/0017-background-conversation-transitions.md)    | 后台会话事务与下一次新建引擎             |
| [0018](adr/0018-global-next-conversation-connection.md)    | 全局下个对话接入与不可变会话快照         |
| [0019](adr/0019-device-aware-conversation-admission.md)    | 设备感知会话准入与单调工作区快照         |

## releases

[releases/](releases/) 每个版本一份发布说明。已发布的不回改。

## archive

[archive/](archive/) 历史路线图、旧版计划、缺陷清单、分阶段修复提示词。每份开头标记为历史材料，不代表当前规格。

## 写文档

- 一页只做一件事：解释、参考、指南、决策不混写。
- 只列信息，不做修辞。
- 数字给实测值，不给约数。
- 参考类文档里的清单必须完整，不写"等等"。
- 代码与文档同一次改动内同步，不留待后续。
