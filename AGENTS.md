# ClaudeDock 项目规则

- 项目定位：Windows 桌面 PowerShell 控制面板；不得修改 Codex、Claude Code 或系统级 API 路由。
- 路由接管边界：只管理 Claude Code / Codex 的 CLI 会话。不得安装、卸载、终止或改写 Claude、Codex、
  CCR 的桌面 App；CCR RPC 保存配置必须保持 `applyProfile: false`，由 ClaudeDock 启动 CLI 时注入本机路由。
- 默认接入必须是单一自动事务：软件检测环境、补齐组件、选择必要路由、发现模型、真实测试并保存；
  普通用户不手动选择路由内核、不填写可实时发现的模型标识，路由/网关后台只作为高级诊断入口。
- 必读文档：`README.md`、`design.md`、`technical.md`。
- 入口：`src/main/main.ts`、`src/preload/preload.ts`、`src/renderer/main.ts`。
- 修改后至少运行：`npm run lint`、`npm run format:check`、`npm run typecheck`、`npm test`、
  `npm run test:layout`、`npm run test:control-theme`、`npm run build`。
- UI、运行方式或技术实现变化时，同步检查三个根目录文档。
- 生成目录：`dist/`、`outputs/`；Electron Builder 的安装包和解包目录统一输出到 `outputs/`，
  不得再复制到项目根目录，生成目录和安装包均不提交 Git。
- 任何私钥、Token、证书密码、管理凭据、非公开管理端点/用户名或本机凭据路径都不得进入仓库、
  安装包、客户端源码、Issue、PR、日志或最终回复。
- 网络预检只允许访问服务商配置中的官方端点；不得恢复第三方公网地址、地区、ASN 或网络信誉请求，
  不得根据用户位置作判断。外部应用代理只传递用户填写的连接参数，不读取或迁移旧版网络配置。
