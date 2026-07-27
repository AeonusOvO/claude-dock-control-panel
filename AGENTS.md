# ClaudeDock 项目规则

- 项目定位：Windows 桌面 PowerShell 控制面板；不得修改 Codex、Claude Code 或系统级 API 路由。
- 必读文档：`README.md`、`design.md`、`technical.md`。
- 入口：`src/main/main.ts`、`src/preload/preload.ts`、`src/renderer/main.ts`。
- 修改后至少运行：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`。
- UI、运行方式或技术实现变化时，同步检查三个根目录文档。
- 生成目录：`dist/`、`outputs/`；Electron Builder 的安装包、校验元数据和解包目录统一输出到
  `outputs/`，不得再复制到项目根目录，生成目录和安装包均不提交 Git。
- 每次完成项目修改都必须更新 `package.json` 与 `package-lock.json` 中的版本号，不得沿用
  上一次发布版本。结合 SemVer 与项目发布尺度自主判断：不兼容或架构级变更升主版本，
  有明确发布价值的成组/重大新功能升次版本，小功能优化、修复、文档、构建或维护改动升
  修订版本；不要仅因为出现了新行为就机械升次版本，判断不确定时在最终说明中写明依据。
- 完成验证和版本更新后必须运行 `npm run dist`。确认
  `outputs/ClaudeDock-Setup-<version>-x64.exe` 以及配套的 blockmap、`latest.yml` 和
  `win-unpacked/` 均在 `outputs/` 中生成；不得把安装包或配套产物复制到项目根目录。
- 最终回复必须写明版本变更（旧版本 → 新版本）和本轮生成的安装包路径；若打包失败，必须说明
  失败原因和未生成的产物，不得把只有 `npm run build` 描述成已完成发布。
