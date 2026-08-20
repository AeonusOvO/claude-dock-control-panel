# ADR-0007 单一发布目录与产物清单

- 状态：已采纳
- 日期：2026-08-19

## 背景

可分发产物历史上出现在三个位置：`outputs/`（electron-builder 当前配置）、`release/`、仓库根的 `ClaudeDock-Setup-*.exe`。`.gitignore` 同时保留这三条规则，说明三处都真实产出过。后果是「这次发布在哪个目录」需要靠记忆，陈旧安装包会与新产物混在同一目录。

发布记录（绝对路径、版本、文件大小、SHA-256、签名状态）此前靠人工执行 PowerShell 逐项抄录。`latest.yml` 的 SHA-512 与安装包实际摘要是否一致没有任何自动校验——这条链断了，应用内更新会下载后校验失败并静默放弃。

## 决策

1. `outputs/` 是唯一发布目录。构建产物分两级，各自单一归属：

   | 目录       | 内容                                                       | 谁消费                  |
   | ---------- | ---------------------------------------------------------- | ----------------------- |
   | `dist/`    | 编译后的 `main`/`preload`/`renderer`/`shared` 包           | Electron 运行时         |
   | `outputs/` | 安装包、`.blockmap`、`latest.yml`、`release-manifest.json` | 用户与 electron-updater |

2. `npm run release` 是唯一发布命令：`npm run dist` 之后立即运行 `scripts/release/manifest.mjs`。

3. `scripts/release/manifest.mjs` 是发布门禁，任一项不成立就非零退出：

   - 三个必需产物齐全：`ClaudeDock-Setup-<version>-x64.exe`、同名 `.blockmap`、`latest.yml`。
   - `latest.yml` 的 `version` 与 `path` 同 `package.json` 的 `version` 派生值一致。
   - `latest.yml` 的 `sha512` 与 `size` 等于安装包实际值——直接校验更新链，而不是假设 electron-builder 写对了。
   - 目录内没有陈旧文件（其他版本的安装包、手工拷入的文件）。

4. 产物记录由脚本生成到 `outputs/release-manifest.json`：版本、每个产物的字节数与 SHA-256、安装包的 Authenticode 状态、生成时间。发布说明里的数字从这个文件抄，不再手工执行 `Get-FileHash`。

## 结果

- 「发布在哪个目录」不再是问题：`outputs/` 之外任何位置出现安装包都是错误。
- 更新链的断裂在打包机上就暴露，而不是在用户的更新失败里暴露。
- 陈旧产物混入目录会让发布门禁失败，不会被误上传。
- 代价：`outputs/` 里保留上一版本产物的习惯要改成发布前清空。
- 代价：脚本读 `latest.yml` 用的是最小 YAML 解析（正则取字段），electron-builder 改变 `latest.yml` 结构时需要同步改脚本。

## 备选方案

**改用 electron-builder 默认的 `dist/` 作为发布目录** —— 与编译产物目录冲突，需要把编译产物迁到 `out/`，牵动 `package.json` 的 `main`、三个 tsconfig 的 `outDir`、`vite.config.ts`、清理脚本与全部冒烟脚本的路径假设。收益只是目录名更常见。

**保留人工记录流程** —— 不增加脚本，但 `latest.yml` 与安装包脱节这一类故障仍然只能在发布后被用户发现。

**在 CI 里打包并上传产物** —— 能彻底消除本机差异，但需要 Windows runner 上跑完整 `electron-builder` 与代码签名凭据；签名凭据不在当前范围内，先把本机发布流程固定下来。
