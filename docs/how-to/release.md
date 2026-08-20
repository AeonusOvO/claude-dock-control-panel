# 发布

仅发布 Windows x64 NSIS 安装包。

## 步骤

1. 全门禁通过（见 [verify.md](verify.md)）。
2. `package.json` 的 `version` 改为目标版本。
3. 新建 `docs/releases/<version>.md`。
4. 清空 `outputs/`，只保留 `.gitkeep`。
5. `npm run release`（= `npm run dist` + 产物门禁）。
6. 从 `outputs/release-manifest.json` 抄绝对路径、版本、文件大小、SHA-256、签名状态。
7. 在 GitHub 建 Release，标签 `v<version>`，上传三个产物。

## 产物目录

`outputs/` 是唯一发布目录，`dist/` 只放编译产物，其他任何目录出现安装包都是错误（[ADR-0007](../adr/0007-single-release-directory.md)）。

`npm run release:manifest` 可单独重跑，它校验四件事，任一不成立即非零退出：

- 三个必需产物齐全。
- `latest.yml` 的 `version`、`path` 与当前版本一致。
- `latest.yml` 的 `sha512`、`size` 等于安装包实际值。
- 目录内没有其他版本的陈旧文件。

## 产物

| 文件                                          | 用途                                  |
| --------------------------------------------- | ------------------------------------- |
| `ClaudeDock-Setup-<version>-x64.exe`          | 安装包                                |
| `ClaudeDock-Setup-<version>-x64.exe.blockmap` | electron-updater 差分下载             |
| `latest.yml`                                  | 更新清单：版本、文件名、SHA-512、体积 |

三个文件必须同时上传。缺 `latest.yml` 时应用内更新检查查不到新版本；缺 `.blockmap` 时更新器退回全量下载。

## 版本号

`package.json` 的 `version` 是唯一来源，安装包文件名、`latest.yml`、应用内显示的版本全部由它派生。GitHub Release 标签用 `v<version>`。

RC 版本用 `5.0.0-rc.N`。electron-updater 默认不把预发布版本推给稳定通道。

## 更新契约

`package.json` 的 `build.publish` 指向 GitHub provider。应用内「检查所有更新」的流程：

1. 拉取 `latest.yml`。
2. 对比版本号，低于或等于当前版本时不更新。
3. 按 `latest.yml` 的 SHA-512 下载并校验。
4. 摘要不符时放弃，保留当前版本。

破坏这条链的改动：改 `artifactName` 而不同步改 Release 里的文件名、只上传 exe 不上传 `latest.yml`、手工编辑 `latest.yml` 的摘要。

## 签名

本地构建无代码签名，`Get-AuthenticodeSignature` 返回 `NotSigned`，Windows SmartScreen 会显示未知发布者。发布说明里按实际状态写明。

## 发布说明格式

参照 `docs/releases/` 下既有文件：

```markdown
# ClaudeDock <version>

发布日期：YYYY-MM-DD

## 变更

- 按功能域分条，写清用户可见的行为差异。

## 验证门禁

- 列出实际跑过的命令与结果数字。
```

已发布的说明不回改内容——它们是历史记录。

## 发布后

1. 应用内「检查所有更新」验证一次更新链路。
2. 确认 `outputs/` 未提交 Git（`.gitignore` 已覆盖）。
3. `outputs/release-manifest.json` 是该次发布的记录来源，发布说明里的数字从它抄。
