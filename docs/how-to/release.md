# 发布

仅发布 Windows x64 NSIS 安装包。GitHub Releases 提供手动下载与历史记录；腾讯云 COS 的通用 HTTPS
feed 提供应用内更新。`npm run release` 只构建和校验，不向任何外部服务上传。

## 发布完成定义

正式发布必须让目标通道用户能够从软件右上角“检查更新”发现新版本，并完成显式下载与重启安装。
Git 提交、本地 `npm run dist`、GitHub Release 或单独上传安装包都只是发布过程的一部分，不能单独称为
“用户可更新”。每次用户可见、运行方式或技术实现更新都必须递增 SemVer，生成同一构建 cohort 的安装包、
blockmap 和通道清单，通过完整 `npm run release` 门禁，再按不可变资产优先、通道清单最后的顺序发布到
COS 并完成远端复核。没有完成通道发布的版本统一标记为“已提交/待发布”。

## 步骤

1. 将 `package.json` 的 `version` 改为目标版本并同步 lockfile；确认 `build.files` 字面包含根目录 `LICENSE` 与 `NOTICE`。
2. 新建 `docs/releases/<version>.md`，只记录稳定的变更与验收契约；不要预写测试数量、产物大小、摘要或签名结论。
3. 提交本次发行需要的全部源码、测试和文档。最终候选的全部门禁（见 [verify.md](verify.md)，包括三项 opt-in Windows 集成测试）必须在该 exact commit 上运行；测试数量只取自这些 exact-commit 命令日志。
4. 运行 `npm run release:clean` 定向清理门禁产生的旧 `outputs/` 内容，使目录不存在或除仓库跟踪的空
   `.gitkeep` 外为空。该脚本只接受仓库根目录下的真实 `outputs/` 目录并拒绝符号链接。
5. 确认 `git status --short --untracked-files=all` 无输出，再运行 `npm run release`。该 Node 编排器依次执行 `npm ci`、lint、format check、全部 typecheck、全量 Vitest、dependency-cruiser、`npm run dist`、源码身份复核和 `release:manifest`；不访问外部发布服务。
6. 检查 `outputs/release-manifest.json` 的 `problems` 为空，并核对版本、通道、feed、源码 HEAD、lockfile SHA-256、cohort、文件大小、SHA-256、SHA-512 和 Authenticode 状态；产物事实只取自这份最终 manifest。
7. 在 GitHub 建立标签为 `v<version>` 的 Release，把 exact-commit 日志中的测试结果和最终 manifest 中的产物事实写入验证说明，并上传安装包、blockmap 和本次通道清单。GitHub 资产用于手动安装和追溯，不是 rc.15 之后的应用内更新源；`release-manifest.json` 保持本地，不上传其中的工作站路径。
8. 在只存在于发布进程环境变量或 CI secret 的最小权限 COS 凭据下运行
   `npm run release:publish:cos`。稳定版需要同时让 RC 用户转入稳定版时运行
   `npm run release:publish:cos -- --promote-rc`。
9. 核对公开 COS 对象的长度、摘要、缓存头、单字节 Range 和通道清单，再从真实候选包执行应用内检查。

`5.0.0-rc.15` 是一次性手动引导版本。rc.14 或更早版本内嵌 GitHub provider，不能远程改成 COS；
这些用户必须从 GitHub Releases 手动安装 rc.15。之后的 RC 客户端读取 COS `rc.yml`。已经上传的 rc.14
安装包不得覆盖、改名或作为 COS 引导对象复用。

## 产物目录

`outputs/` 是唯一发布目录，`dist/` 只放编译产物，其他目录出现安装包都是错误
（[ADR-0007](../adr/0007-single-release-directory.md)）。

| 文件                                          | 用途                                          |
| --------------------------------------------- | --------------------------------------------- |
| `ClaudeDock-Setup-<version>-x64.exe`          | 版本化 NSIS 安装包                            |
| `ClaudeDock-Setup-<version>-x64.exe.blockmap` | electron-updater 差分下载                     |
| `<channel>.yml`                               | 当前通道版本、文件名、SHA-512、体积和发布时间 |
| `release-manifest.json`                       | 本地发布门禁报告，不上传为更新清单            |
| `release-orchestration.json`                  | 完整发行编排与 frozen manifest 的本地绑定记录 |

通道从 `package.json` 的版本和 `build.detectUpdateChannel` 派生：

| 版本示例       | 通道     | 清单         |
| -------------- | -------- | ------------ |
| `5.0.0-rc.18`  | `rc`     | `rc.yml`     |
| `5.0.0-beta.2` | `beta`   | `beta.yml`   |
| `5.0.0`        | `latest` | `latest.yml` |

安装包、blockmap 和当前通道清单必须属于同一次最终构建。缺通道清单时客户端无法发现版本；缺 blockmap
时更新器可能退回全量下载。不要手工改清单中的摘要或文件名。

## 本地产物门禁

`npm run release:manifest` 可单独重跑本地产物校验，但它不会生成可发布的编排记录；COS 发布只接受由完整
`npm run release` 在全部步骤成功后绑定的 frozen manifest。它校验：

- `build.publish` 恰好包含一个 `generic` provider；feed 使用 HTTPS、以 `/` 结尾，且无 userinfo、查询参数
  或片段。
- 腾讯云 COS feed 固定 `useMultipleRangeRequest: false`。
- 安装包、blockmap 和派生出的通道清单三项齐全，目录内没有其他版本的陈旧发布文件。
- 清单 YAML 可结构化解析，`files` 恰好有一个完整对象。
- 清单 `version`、`files[0].url`、`path`、`files[0].size` 和两个 SHA-512 字段均与实际安装包一致。
- 版本和通道是有效 SemVer；数字预发布标识不接受前导零。
- Git source tree 没有 tracked 或 untracked 改动；报告记录完整 HEAD、`treeClean: true` 和
  `package-lock.json` 的 SHA-256。ignored `dist/`、`outputs/` 不计入源码 dirt。
- `npm run build` 在 clean 后、任何图标生成、typecheck 或编译前写入 `dist/build-source-identity.json`；开发态允许记录 `treeClean: false`，最终发布只接受 clean identity。打包后的 ASAR 必须包含该固定 schema 文件并与当前源码身份一致。
- `outputs/win-unpacked/resources/app.asar` 的根 `package.json` 版本正确，根 `LICENSE`、`NOTICE` 存在且
  非空，renderer assets 恰好包含三个 hashed 品牌 SVG 且字节与源码相同，ASAR 与整个 `win-unpacked`
  都没有 `claude.exe`。
- 使用固定的 `7zip-bin` 只解压而不运行 NSIS，并读取其直接物化的 application payload。安装器 payload 的 `resources/app.asar`、完整 `app.asar.unpacked` 树和存在性对称的 `app-update.yml` 必须逐字节等于同批次 `win-unpacked`。
- `outputs/win-unpacked/resources/app-update.yml` 是与源码配置精确一致的 generic HTTPS feed，包含与发行版本相同的通道，且 `useMultipleRangeRequest=false`。
- 外部 blockmap 必须是 gzip JSON v2，恰好覆盖安装包的单个 `file` entry；所有 chunk size、18-byte Base64 checksum 和逐块 BLAKE2b-144 都必须有效。报告记录 blockmap 与 installer payload 的确定性 cohort evidence。
- Authenticode 在当前 RC 策略下只接受明确的 `Valid` 或 `NotSigned`；空值、未知、不可用、校验失败、信任失败和其他状态都会产生 release problem。

报告写入 `outputs/release-manifest.json`，包含 provider、feed URL、通道、清单名、源码身份、blockmap 与
installer payload cohort、每个发布产物的字节数、SHA-256、SHA-512、安装包 Authenticode 状态和问题列表。
完整 `npm run release` 随后写入 `release-orchestration.json`，记录固定步骤、相同源码身份和 frozen report
的字节数与 SHA-256；单独运行 manifest 不产生该记录。两者都是未签名的本地记录，不是 electron-updater
通道清单，也不是信任签名。

## COS 配置

打包进应用的无凭据 feed 固定为：

```text
https://claudedock-1304375868.cos.ap-shanghai.myqcloud.com/updates/windows/x64/
```

发布脚本只从环境变量读取 COS 配置：

| 变量                         | 要求                                 |
| ---------------------------- | ------------------------------------ |
| `TENCENT_COS_BUCKET`         | 必填；当前为 `claudedock-1304375868` |
| `TENCENT_COS_REGION`         | 必填；当前为 `ap-shanghai`           |
| `TENCENT_COS_PREFIX`         | 必填；当前为 `updates/windows/x64/`  |
| `TENCENT_COS_SECRET_ID`      | 必填；发布身份的 Secret ID           |
| `TENCENT_COS_SECRET_KEY`     | 必填；发布身份的 Secret Key          |
| `TENCENT_COS_SECURITY_TOKEN` | 可选；STS 临时会话 token             |

bucket、region 和 prefix 必须精确还原打包 feed，否则脚本拒绝发布。应用、源码、文档、测试、日志和清单中
都不得保存 COS 写凭据、临时签名查询或安全 token。脚本会净化已知凭据、授权字段和签名 URL，但仍不得打印
完整发布环境。

COS 前置条件：

- bucket ACL 保持私有，只通过 bucket policy 公开 feed 对象；不得设为 bucket-wide `public-read` 或
  `public-read-write`。
- bucket 必须从未启用版本控制。发布脚本调用 bucket versioning 查询；`Enabled` 或 `Suspended` 都会拒绝，
  因为 COS 的 `x-cos-forbid-overwrite: true` 在有版本控制历史的 bucket 中不能提供不可覆盖保证。发布身份
  不授予 `PutBucketVersioning`；若当前状态为 `Suspended`，必须改用从未开启版本控制的新 bucket/feed。
- 公开读取只需要 `GetObject` 和 `HeadObject`；单字节 Range 仍使用 `GetObject`，不需要单独权限。不要向匿名
  主体授予 `GetBucket`、上传、覆盖、删除或 ACL 权限。
- 发布锁保持私有。公开策略优先只匹配安装包、blockmap、`rc.yml`、`beta.yml` 和 `latest.yml`，不要把
  `.claudedock-publication-locks/*` 包含在公开 prefix 通配符中。

当前 bucket 的匿名读取策略可使用以下资源边界：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "principal": { "qcs": ["qcs::cam::anyone:anyone"] },
      "action": ["name/cos:GetObject", "name/cos:HeadObject"],
      "resource": [
        "qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/ClaudeDock-Setup-*-x64.exe",
        "qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/ClaudeDock-Setup-*-x64.exe.blockmap",
        "qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/rc.yml",
        "qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/beta.yml",
        "qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/latest.yml"
      ]
    }
  ]
}
```

发布身份使用单独的 CAM 用户或角色，身份策略中不写 `principal`，只授予：

| 对象范围                           | 允许动作                                                            | 条件                                                |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| bucket                             | `name/cos:GetBucketVersioning`                                      | 无                                                  |
| 安装包、blockmap                   | `name/cos:HeadObject`、`name/cos:PutObject`                         | `PutObject` 必须携带 `x-cos-forbid-overwrite: true` |
| `rc.yml`、`beta.yml`、`latest.yml` | `name/cos:HeadObject`、`name/cos:PutObject`                         | 无；通道清单必须允许覆盖                            |
| `.claudedock-publication-locks/*`  | `name/cos:GetObject`、`name/cos:PutObject`、`name/cos:DeleteObject` | `PutObject` 必须携带 `x-cos-forbid-overwrite: true` |

身份策略的 resource 精确限制为：

```text
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/*
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/ClaudeDock-Setup-*-x64.exe
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/ClaudeDock-Setup-*-x64.exe.blockmap
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/rc.yml
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/beta.yml
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/latest.yml
qcs::cos:ap-shanghai:uid/1304375868:claudedock-1304375868/updates/windows/x64/.claudedock-publication-locks/*
```

第一项只用于 `GetBucketVersioning`；其余动作必须使用对应对象范围，不得把 bucket resource 复用于对象
写入。不可变对象和锁的 CAM 策略同时添加 `string_equal` allow 与
`string_not_equal_if_exist` deny：

```json
{
  "condition": {
    "string_equal": {
      "cos:x-cos-forbid-overwrite": "true"
    }
  }
}
```

```json
{
  "condition": {
    "string_not_equal_if_exist": {
      "cos:x-cos-forbid-overwrite": "true"
    }
  }
}
```

显式 deny 会在 header 缺失或值不为字符串 `true` 时拒绝写入。不要把该条件应用到通道清单，否则
`rc.yml`、`beta.yml` 和 `latest.yml` 无法按设计向前更新。当前发布器不需要 multipart upload、bucket
列举、对象 ACL、bucket ACL 或版本控制写权限。版本化对象的公开摘要验证使用匿名 HTTPS，不需要把读取
凭据打包进应用。

## COS 发布语义

`npm run release:publish:cos` 把现有 `outputs/release-manifest.json` 当作 frozen report，不重新生成、覆盖或
改变其中的 `generatedAt`，然后按以下顺序工作：

1. 先要求 `release-orchestration.json` 记录完整固定步骤、相同 clean source identity，并以字节数与 SHA-256
   精确绑定 frozen report；缺失记录、单独重跑 manifest 或报告字节变化均拒绝。随后执行 `writeReport: false`
   的完整本地验证；ASAR 内 packaged build identity 必须与 frozen source identity 一致，当前 source tree
   必须 clean，Git HEAD、`package-lock.json` SHA-256、全部产物摘要、NSIS payload byte linkage、blockmap
   chunk 校验、cohort evidence 和其余验证元数据也必须与 frozen report 精确一致。通道 YAML 在此阶段冻结
   为已核对摘要的内存字节，后续上传和公开回读不再读取可变本地路径。
2. 查询 bucket versioning，确认原子 create-only 写入可用。
3. 对安装包和 blockmap 执行 HEAD；相同版本化 key 只允许复用一致对象。
4. 缺失对象使用 `x-cos-forbid-overwrite: true` 原子创建；并发创建冲突后重新读取，绝不覆盖现有字节。
5. 对两个版本化对象分别验证公开 HEAD、`Range: bytes=0-0` 的 206/Content-Range/首字节，以及完整公开
   GET 的 SHA-256、SHA-512、长度和缓存头。
6. 对全部目标通道按名称获取带唯一 owner token 的 create-only 发布锁，并在任何通道写入前预检所有
   远端版本。若 COS 已创建锁但成功响应丢失，脚本只在回读 body 与本次 token 精确一致时恢复所有权。
7. 仅在版本化对象和全部通道预检通过后写入通道清单；通道清单始终最后发布并立即公开回读验证。
8. 释放前再次核对 owner token，再按反向顺序删除锁；不删除所有权已变化的对象。

版本化 key 不可变：远端大小或摘要不同即失败；元数据缺失时仍以完整公开摘要为准。相同对象可复用。
通道只能前进：远端版本更高时拒绝；同版本不同文本时拒绝；同版本相同文本时幂等复用。

稳定版默认只发布 `latest.yml`。`--promote-rc` 在稳定构建上同时将 `latest.yml` 和 `rc.yml` 指向同一
稳定安装包；预发布构建不得执行稳定推广。所有目标通道先加锁并全部预检，但多个可变对象不是 COS
事务：服务故障仍可能发生部分写入。排除故障后重跑同一幂等命令完成收敛。

发布锁位于：

```text
updates/windows/x64/.claudedock-publication-locks/<channel>.lock
```

脚本异常退出可能留下锁。只有确认没有发布进程仍在运行、且已核对远端通道和版本化对象后，才可删除
对应锁并重跑；不得把“锁存在”当成可直接清理的陈旧文件。

## 缓存策略

| 对象                    | `Cache-Control`                        |
| ----------------------- | -------------------------------------- |
| 安装包、blockmap        | `public, max-age=31536000, immutable`  |
| `rc.yml` / `latest.yml` | `no-cache, max-age=0, must-revalidate` |
| 临时发布锁              | `no-store`                             |

版本化对象不得原地替换，因此可以长期缓存；通道清单是可变指针，每次检查必须重新验证。

## 腾讯云控制台备用流程

控制台只用于自动脚本不可用时的人工备用，且必须在独占发布窗口内执行：

1. 运行 `npm run release:manifest`，确认报告无问题，并确认没有脚本发布进程或发布锁。
2. 确认 bucket 从未启用版本控制，且目标版本化 key 不存在；若已存在，先公开下载并比对完整长度、
   SHA-256、SHA-512。不同即停止，不得覆盖。
3. 先上传安装包，再上传 blockmap，分别设置不可变缓存头和正确 Content-Type。
4. 匿名验证两个对象的 HEAD、单字节 Range、完整长度和摘要。
5. 最后上传当前通道清单并设置 no-cache 头；稳定推广时在全部远端版本预检通过后再更新
   `latest.yml` 和 `rc.yml`。
6. 匿名回读清单，核对文本、版本、文件名、长度和 SHA-512。

控制台流程不能自动复现脚本的原子 create-only、并发锁、凭据净化和回滚保护；只允许一个发布者操作，
脚本恢复后应重新运行幂等发布验证远端状态。

## 完整性与真实性

- electron-updater 的 SHA-512 证明下载的安装包与所读取通道清单一致，并能发现传输或元数据错配。
- HTTPS 验证 COS 主机并保护传输；缓存和发布前验证降低不一致发布概率。
- 当前通道清单没有独立签名。最终候选的 Authenticode 状态只能由最终 `release-manifest.json` 确定；RC
  门禁接受明确的 `Valid` 或 `NotSigned`，构建前不得预先声称其中任何一种。
- 若最终状态为 `NotSigned`，构建配置也没有 `publisherName` 身份约束；Windows SmartScreen 可能显示
  未知发布者。若最终状态为 `Valid`，发布说明仍须记录 manifest 中的实际状态，不把摘要链替代签名。
- 能同时改写 COS 清单和安装包的主体可以生成一条新的自洽摘要链。因此“已下载”“SHA-512 通过”或
  “TLS 可用”都不能描述为“发布者身份已验证”或“供应链已验证”。

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

1. 核对 GitHub 手动下载资产和 COS feed 的职责没有混淆。
2. 匿名验证 COS 当前通道清单、缓存头、版本化对象的长度、Range 和摘要。
3. 从本次真实安装包或同批次 `win-unpacked` 执行“检查所有更新”；检查不得自动下载。
4. rc.15 需要完成一次手动安装后读取 COS `rc.yml` 的引导证明；第一次完整生产更新证明使用
   rc.15 → rc.16，覆盖检查、显式下载、重启安装和版本确认。在完整序列真实通过前，发布记录只能标为待验证。
5. 确认 `outputs/` 未提交 Git；测试数量取自 exact-commit 日志，产物数字只从最终 `release-manifest.json` 抄录。
