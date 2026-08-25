# ClaudeDock 项目规则

## 项目

- 定位：Windows 桌面控制面板，管理 Claude Code / Codex 的 CLI 会话与 PowerShell 终端。
- 入口：`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/main.ts`。
- 生成目录：`dist/`（构建产物）、`outputs/`（安装包）。两者都不提交 Git。
- 默认接入是单一自动事务：检测环境、补齐组件、选择路由、发现模型、真实测试、保存。普通用户不手动
  选择路由内核，也不填写可实时发现的模型标识；路由与网关后台只作为高级诊断入口。

## 文档

| 文档                               | 内容                     |
| ---------------------------------- | ------------------------ |
| `docs/README.md`                   | 文档地图                 |
| `docs/explanation/architecture.md` | 分层、进程边界、依赖规则 |
| `docs/reference/project-layout.md` | 目录地图                 |
| `docs/reference/ipc-contract.md`   | IPC 频道与 API 方法映射  |
| `docs/explanation/design.md`       | 设计系统                 |
| `docs/reference/technical.md`      | 技术实现                 |
| `docs/how-to/`                     | 开发、验证、发布         |
| `docs/adr/`                        | 决策记录                 |

## 验证

| 命令                                                                     | 检查                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint`                                                           | ESLint（`src`、`tests`、`scripts`、`vite.config.ts`、`vite.preload.config.ts`），`--max-warnings=0`，任何 warning 即失败 |
| `npm run lint:deps`                                                      | 分层规则、循环依赖、孤儿模块                                                                                             |
| `npm run format:check`                                                   | Prettier                                                                                                                 |
| `npm run typecheck`                                                      | 三个 tsconfig（渲染端与测试 / 主进程 / preload）                                                                         |
| `npm test`                                                               | Vitest                                                                                                                   |
| `npm run build`                                                          | 主进程 + 渲染进程构建                                                                                                    |
| `npm run test:layout` `npm run test:control-theme` `npm run test:visual` | 真实 Electron 布局与主题                                                                                                 |
| `npm run test:runtime-soak:accelerated`                                  | 长时运行                                                                                                                 |
| `npm run dist`                                                           | Windows NSIS 安装包                                                                                                      |

改完代码跑到 `npm run dist`，不要只交付开发构建。UI、运行方式或技术实现变化时同步更新对应文档。

## 更新交付

- 任何用户可见、运行方式或技术实现更新都必须通过软件右上角“检查更新”完成正式交付；只提交代码、
  只生成开发构建或只上传单个安装包都不算发布完成。
- 每次发布必须递增 SemVer 版本，生成同一次最终构建的 NSIS 安装包、blockmap 与对应通道清单（RC 使用
  `rc.yml`，beta 使用 `beta.yml`，稳定版使用 `latest.yml`），并通过完整发行编排与更新器验收。
- 发布到 COS 时先写入并验证不可变安装包与 blockmap，最后推进通道清单；随后必须使用真实候选包从
  右上角“检查更新”验证发现、下载和安装链路。
- 未完成通道发布与远端复核的改动只能标记为“已提交/待发布”，不得标记为“用户可更新”。
