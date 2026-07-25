# ClaudeDock 项目规则

- 项目定位：Windows 桌面 PowerShell 控制面板；不得修改 Codex、Claude Code 或系统级 API 路由。
- 必读文档：`README.md`、`design.md`、`technical.md`。
- 入口：`src/main/main.ts`、`src/preload/preload.ts`、`src/renderer/main.ts`。
- 修改后至少运行：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`。
- UI、运行方式或技术实现变化时，同步检查三个根目录文档。
- 生成目录：`dist/`、`release/`；最终安装包发布到项目根目录并由 `.gitignore` 排除，
  生成目录和安装包均不提交 Git。
