# ADR-0007 单一发布目录与 COS 更新链

- 状态：已采纳
- 日期：2026-08-19
- 更新：2026-08-23

## 背景

可分发产物历史上出现在 `outputs/`、`release/` 和仓库根目录。目录漂移会让陈旧安装包混入新版本，
人工抄录大小、摘要和签名状态也无法证明通道清单仍与最终安装包一致。

旧应用更新链有两个冲突来源：更新中心通过 GitHub Releases API 判断 ClaudeDock 版本，
electron-updater 又读取安装包内嵌的 GitHub provider。预发布版本不能稳定完成 RC 到 RC 的发现，已经构建的
安装包也不能远程改写其 `app-update.yml`。腾讯云 COS 可提供公开 HTTPS、单字节 Range 和低成本小型通道
清单，但上传单个 exe 不足以构成 electron-updater feed。

发布链同时需要区分完整性和真实性。清单 SHA-512 可以发现安装包与元数据不一致；如果攻击者能同时替换
清单和安装包，自洽摘要不能证明发布者身份。当前 NSIS 产物和通道清单均未签名。

## 决策

1. `outputs/` 是唯一发布目录：

   | 目录       | 内容                                                               | 消费者                           |
   | ---------- | ------------------------------------------------------------------ | -------------------------------- |
   | `dist/`    | 编译后的 `main`、`preload`、`renderer`、`shared`                   | Electron 运行时                  |
   | `outputs/` | 安装包、blockmap、通道 YAML、`release-manifest.json`、解包候选目录 | 用户、发布工具、electron-updater |

2. `package.json` 的版本是发布身份的唯一来源。开启 `detectUpdateChannel`：`5.0.0-rc.N` 使用
   `rc.yml`，`5.0.0-beta.N` 使用 `beta.yml`，稳定版使用 `latest.yml`。安装包和 blockmap 文件名包含完整
   版本，发布后不可原地替换。

3. electron-builder 只配置一个无凭据 `generic` provider：

   ```text
   https://claudedock-1304375868.cos.ap-shanghai.myqcloud.com/updates/windows/x64/
   ```

   feed 必须使用 HTTPS、以 `/` 结尾、无 userinfo、查询参数和片段，并固定
   `useMultipleRangeRequest: false`。应用不读取 COS 写凭据，不在运行时切换 feed。

4. 命令职责分离：

   - `npm run dist`：构建 Windows x64 产物。
   - `npm run release:manifest`：校验本地产物和更新链。
   - `npm run release`：依次执行前两项，不上传。
   - `npm run release:publish:cos`：用发布进程环境凭据发布已验证产物。
   - `npm run release:publish:cos -- --promote-rc`：稳定版同时推进 `latest.yml` 和 `rc.yml`。

5. `scripts/release/manifest.mjs` 是可复用发布门禁，任一项不成立就非零退出：

   - 安装包、同名 blockmap、当前通道 YAML 三项齐全，目录内没有陈旧发布文件。
   - `build.publish` 恰好是一个符合约束的 generic COS feed。
   - YAML 结构可解析，`files` 恰好有一个完整对象。
   - `version`、`files[0].url`、`path`、`files[0].size`、文件项和顶层 SHA-512 均与最终安装包一致。
   - SemVer 和派生通道有效。

6. `outputs/release-manifest.json` 是本地发布记录，包含 provider、feed、通道、产物字节数、SHA-256、
   SHA-512、安装包 Authenticode 状态、生成时间和问题列表。它不上传为更新清单，也不是签名。

7. COS 发布使用不可变资产优先、可变通道最后的协议：

   - bucket 必须从未启用版本控制；脚本先查询 versioning 状态。
   - 安装包和 blockmap 使用 `x-cos-forbid-overwrite: true` 原子创建。并发冲突只允许重新读取和验证，
     不允许覆盖。
   - 两个版本化对象公开通过 HEAD、单字节 Range、完整长度、SHA-256、SHA-512 和缓存头验证后，才处理
     通道清单。
   - 所有目标通道先获取带唯一 owner token 的 create-only 锁并全部预检。创建响应丢失时只接受 body
     与本次 token 相同的锁，释放前再次核对所有权。远端较新版本、同版本不同文本均拒绝；同版本相同
     文本幂等复用。
   - 多通道写入不是跨对象事务；服务故障后的恢复方式是保留不可变对象并重跑幂等命令。
   - 安装包和 blockmap 使用 `public, max-age=31536000, immutable`；通道清单使用
     `no-cache, max-age=0, must-revalidate`；发布锁使用 `no-store`。

8. GitHub Releases 保留为手动安装和发行历史，不再是 rc.15 之后的应用内更新 feed。`5.0.0-rc.15`
   是一次性手动引导：rc.14 或更早用户必须手动安装一次，之后 RC 客户端读取 COS `rc.yml`。旧 rc.14
   对象保持未引用，不覆盖、不复用。

9. electron-updater 是 ClaudeDock 版本、下载和安装状态的唯一权威。检查与下载分离，用户显式开始下载；
   SHA-512 不匹配、降级或通道异常都保留当前安装。GitHub ClaudeDock 版本请求不再参与更新中心聚合。

10. 完整性声明不得扩大为真实性声明。当前 `NotSigned` 安装包、未签名通道清单和无 `publisherName`
    配置意味着“SHA-512 通过”“已下载”或“TLS 可用”都不能显示为“发布者身份已验证”或“供应链已验证”。

## 结果

- 发布目录、版本身份、通道和远端 feed 均有单一事实源。
- 更新链断裂、错误 feed、陈旧产物和通道回退在发布前暴露。
- 版本化 COS key 不会被并发发布者覆盖；通道发布通过锁和预检串行化。
- rc.15 之前的安装无法远程迁移，必须承担一次手动引导成本。
- `outputs/` 中保留旧版本生成物会使门禁失败，发布前必须定向清理。
- bucket 一旦启用或暂停过版本控制就不能满足当前 create-only 假设，需要迁移到新的未版本化发布 bucket
  或重新设计原子协调。
- 脚本异常退出可能留下发布锁；只有确认发布者停止并核对远端状态后才能人工删除。
- SHA-512 和公开摘要验证提高一致性，不提供独立发布者身份。代码签名或独立清单签名需要另行决策。

## 备选方案

**继续使用 GitHub updater provider** —— 手动下载和历史管理方便，但旧的双版本来源与 RC 通道行为已经造成
不一致；不采纳为应用内更新 feed。

**让轻量服务器代理安装包和版本文本** —— 增加带宽、TLS、缓存和运行维护面；COS 已直接提供公开 HTTPS
与单 Range，不引入额外代理层。

**只上传 exe** —— electron-updater 还需要通道 YAML 和 blockmap，无法形成完整更新链。

**使用临时签名 COS URL 作为 feed** —— 查询签名会过期并泄露发布配置，安装包内嵌 URL也无法安全轮换；
不采纳。

**把 COS 凭据打包进应用** —— 客户端凭据可被提取并获得写权限；禁止。

**只用 HEAD 后普通 PUT 保证不可变** —— 两个并发发布者都可能看到对象不存在并互相覆盖；改用 COS
create-only 头并拒绝有版本控制历史的 bucket。

**在 CI 中自动发布全部对象** —— 可以减少本机差异，但需要受控 Windows 构建、发布凭据、互斥和最终确认。
当前保留显式发布脚本，CI 只执行无凭据门禁。

**立即要求 Authenticode 或签名清单** —— 能增加真实性边界，但涉及密钥保管、轮换和客户端信任根；当前按
`NotSigned` 真实记录，不把它伪装成已解决。
