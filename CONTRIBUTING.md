# 参与贡献

## 开始之前

- 使用 Windows 10 1809 或更高版本、Node.js 24+、npm 11+。
- 先搜索现有 Issue；缺陷和功能建议分别使用仓库提供的表单。
- 安全漏洞不要公开提交，按 [SECURITY.md](SECURITY.md) 私密报告。
- 遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 本地开发

```powershell
npm install
npm run dev
```

代码应遵循现有进程边界、状态所有权、命名和注释密度。不要引入平行状态源、未使用的依赖、额外发布系统或与当前改动无关的重构。详细约束见 [开发指南](docs/how-to/develop.md)、[架构](docs/explanation/architecture.md) 和 [设计规范](docs/explanation/design.md)。

## 验证

提交代码前至少运行：

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run lint:deps
npm run build
npm run dist
```

涉及布局、主题、终端、ConPTY 或长时生命周期时，再运行 [验证指南](docs/how-to/verify.md) 中对应的 Electron 冒烟和全门禁。文档改动至少运行 `npm run format:check`。如任何代码或打包声明在最终构建后变化，必须重新运行 `npm run dist`。

## Pull Request

- 保持一次 PR 只解决一个明确问题。
- 写清用户可见变化、实现边界和实际运行的验证命令。
- UI 改动附四主题和受影响尺寸的截图；行为改动附回归测试。
- 同步更新唯一的规范文档，不新增重复路线图、变更日志或架构说明。
- 不提交 `dist/`、`outputs/`、凭据、令牌、签名 URL、完整公网地址或本机私有数据。
- 发布、标签、远端上传和历史删除由维护者在独立发布步骤中完成。
