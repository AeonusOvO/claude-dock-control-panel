# 为 ClaudeDock 贡献代码

感谢你帮助改进 ClaudeDock。本项目是采用 Apache-2.0 许可证的 Windows 桌面应用，欢迎提交范围
清晰的缺陷修复、测试、文档和功能改进，但必须保持既定产品边界。

## 提交 Pull Request 前

1. 较大的行为或架构变更请先通过 Issue 讨论。
2. 从最新 `main` 创建短生命周期分支。
3. 一个分支只处理一个主题，不要提交生成产物、凭据、本地数据库或安装包。
4. 行为、设计或架构变化时，同步更新测试及对应的根目录文档。
5. 在 Windows 上运行 `npm ci`、`npm run verify` 和 `npm run dist`。
6. 在 Pull Request 中写明目的、主要变更、验证结果、风险和待确认项。

版本号由维护者确定。不得提交私钥、Token、证书密码、真实 AI 凭据或个人测试数据；测试应使用
`example.com` 域名和明确的虚构占位值。

所有贡献均按 Apache License 2.0 提供。提交贡献即表示你有权按该许可证提供相关内容，并已为
第三方材料标注适用许可证。

安全漏洞必须按 [SECURITY.md](SECURITY.md) 私密报告，不要创建公开 Issue。
