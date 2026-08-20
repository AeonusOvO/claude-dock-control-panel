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
