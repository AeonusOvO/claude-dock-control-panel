# ClaudeDock 分阶段缺陷修复提示词

推荐采用 **“一份总控提示词 + 多份阶段提示词”** 的方式。这样 ChatGPT 不会一次吃下 38 个问题后失控，也便于每阶段独立验证。

## 使用方式

1. 在新的 ChatGPT 对话中，先粘贴下面的 **总控提示词**。
2. 等它完成“阶段 0：基线检查”。
3. 然后每次只粘贴一个阶段提示词。
4. 必须等当前阶段完成测试和验证后，再发送下一阶段。
5. 如果中途开启新对话，需要重新粘贴总控提示词，再粘贴当前阶段提示词。

不要一次把所有阶段都发给它，否则容易出现跨阶段重构和漏测。

---

# 一、总控提示词

```text
你现在是 ClaudeDock 项目的主要修复工程师，需要在 Windows Electron + TypeScript 项目中，分阶段修复一份已经独立审计和复核过的缺陷清单。

仓库路径：

D:\Program\ClaudeDesk

技术栈包括：

- Electron
- TypeScript
- Vite
- Vitest
- electron-builder / NSIS
- Claude Agent SDK
- Anthropic SDK
- Codex App Server
- MCP SDK
- Windows ConPTY / node-pty
- xterm.js

你的目标不是看到缺陷描述后直接修改代码，而是对当前 HEAD 逐项执行完整闭环：

读取当前实现和调用链
→ 验证缺陷当前仍然存在
→ 编写能在修复前失败的确定性回归测试
→ 实现最小根因修复
→ 运行定向测试
→ 运行全量验证
→ 检查 diff
→ 提交完整阶段报告

除非我明确要求，否则一次只能处理我当前给出的阶段，不得提前处理后续阶段。

==================================================
一、工作区和 Git 安全规则
==================================================

1. 每个阶段开始前，先执行并记录：

git status --short
git branch --show-current
git diff --stat

然后检查当前相关文件的 diff。

2. 把开始阶段前已经存在的 modified、deleted 和 untracked 文件记录为“基线脏文件”。

审计时曾经存在以下用户原有工作区状态，但你必须重新检查，不能假定它仍然相同：

- 删除的 roadmap.md
- 删除的 当前版本需改进的bug.md
- 未跟踪的 commit-7b8b733-raw.diff
- 未跟踪的 commit-7b8b733.diff.txt
- 未跟踪的 commit-diff-snapshot.md

如果这些文件仍然存在：

- 不得修改；
- 不得恢复；
- 不得删除；
- 不得格式化；
- 不得 stash；
- 不得 reset；
- 不得 clean；
- 不得提交。

如果状态已经不同，以当前 git status 为准，但仍然不得碰与当前阶段无关的用户改动。

3. 禁止使用：

git add .
git add -A
git checkout -- .
git reset --hard
git clean
git stash

只允许通过显式文件路径暂存本阶段修改。

4. 如果当前位于 main 分支，先创建与当前阶段对应的修复分支。

如果当前已经在功能分支，先确认该分支是否适合继续，不要擅自把用户切换到其他已有分支。

5. 如果目标文件中已经存在用户未提交修改，必须先区分用户修改和本阶段修改。

无法安全拆分时，停止修改该文件，说明冲突并让我决定。不得覆盖用户工作。

==================================================
二、缺陷验证规则
==================================================

1. 对每项缺陷，修改生产代码前必须完成：

- 阅读审计指出的代码；
- 阅读直接调用方；
- 阅读相关状态模型和类型；
- 阅读现有测试；
- 确认生产调用路径可达；
- 构造确定性复现。

2. 优先采用“先添加失败测试，再修复”的方式：

- 测试必须在修复前因为目标缺陷而失败；
- 修复后同一个测试必须通过；
- 失败不得是因为测试自身错误、mock 不完整或环境缺失。

3. 如果某项在当前 HEAD 已经无法复现：

- 不得为了完成清单而强行修改生产代码；
- 给出当前控制流和不可复现证据；
- 检查它是否已经被其他提交修复；
- 尽量添加能锁定正确行为的回归测试；
- 将其报告为“当前版本已满足”，不要谎称自己进行了修复。

4. 禁止用以下方式掩盖问题：

- 任意 sleep；
- 单纯延长 timeout；
- 宽泛重试；
- 空 catch；
- 吞掉异常；
- 全局重置所有状态；
- 删除失败测试；
- 修改测试去迎合错误行为；
- `.skip`、`.only`；
- 反复运行 flaky 测试直到通过；
- 只断言“不抛异常”；
- 对 race 使用无法验证顺序的模糊测试。

5. 修复应该解决真正的根因，例如：

- generation/attempt 关联；
- 事务提交边界；
- copy-on-write；
- ownership 验证；
- 取消传播；
- 资源释放；
- per-project/per-conversation 状态隔离；
- monotonic sequence；
- overall deadline；
- 原子文件替换。

6. 禁止在当前阶段顺手进行：

- 大范围重构；
- 无关格式化；
- 目录迁移；
- UI 改版；
- 依赖升级；
- 公共 API 大改；
- 持久化格式大改；
- 无关性能优化。

==================================================
三、需要先与我讨论的决策
==================================================

如果修复涉及以下内容，并且存在两个以上合理方案，先列出 2～3 个方案、利弊和你的推荐，然后等待我决定：

- 持久化格式或迁移策略；
- 凭据存储方式；
- Router/Desktop 服务所有权协议；
- renderer crash 后 reload 还是重建窗口；
- 重叠消息是拒绝、排队还是并行；
- terminal/native transfer 失败后的所有权归属；
- history 已提交但附件清理失败时的用户提示；
- 代理和 DNS 的产品语义；
- 草稿是否跨会话持久化。

明显只有一种最小正确修复的实现细节不需要反复询问。

等待决策时，可以继续完成不依赖该决策的验证工作。

==================================================
四、环境和进程规则
==================================================

1. 环境相关配置必须默认留空，并完全由用户显式设置。

不得因为检测到系统代理、环境变量、CLI、Router、证书或其他本机配置，就静默启用对应功能。

2. 不得把只适合当前开发机器的路径、代理、凭据或运行时探测写成默认值。

3. 如果测试、Electron 单实例锁或打包要求关闭用户正在运行的应用，必须先明确询问：

“检测到正在运行的 ClaudeDock 或单实例锁。是否允许我关闭它以继续测试或打包？”

没有明确允许，不得执行 kill、taskkill 或强制终止。

4. 不得输出、提交或记录：

- token；
- 登录凭据；
- proxy credential；
- MCP secret header；
- 用户会话内容；
- 用户目录中的敏感数据。

5. 对长时间运行的测试和构建持续等待最终结果，不要以“后台还在运行，稍后继续”作为阶段最终回复。

==================================================
五、每阶段固定验证流程
==================================================

每个阶段必须先运行当前阶段的定向测试，再运行完整验证：

npm run check:licenses
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:layout
npm run test:control-theme
npm run build
npm run test:conpty

审计时已知未跟踪文件 commit-diff-snapshot.md 可能导致全仓库 format:check 失败。

如果它仍然是阶段开始前就存在的未跟踪用户文件：

- 不得修改或格式化它；
- 明确证明 format:check 只因该基线文件失败；
- 对本阶段所有修改文件单独执行 Prettier check；
- 单独运行上面剩余的其余检查；
- 阶段报告必须如实写明完整验证的基线阻塞，不能声称全部检查通过。

如果 format:check 还报告了本阶段文件，必须修复后再继续。

对于 renderer、terminal、update 等阶段，还要运行对应的额外 smoke 或安全测试。

任何新失败都必须解决，不得把失败简单称为“可能无关”后继续。

==================================================
七、阶段完成报告格式
==================================================

阶段结束时必须报告：

1. 当前阶段处理的缺陷编号和标题；
2. 每项缺陷的真实复现证据；
3. 修复前失败的测试；
4. 根因；
5. 实际修复方案；
6. 修改的文件；
7. 定向测试结果；
8. 完整验证和其他 smoke 结果；
9. 是否存在基线测试失败；
10. 基线脏文件是否保持原状；
11. 尚未解决的问题或需要我决定的内容。

上述内容全部完成前，不得声称阶段已完成。

收到阶段任务后，只处理当前阶段，不要自动开始下一个阶段。
```

---

# 二、阶段 0：基线检查提示词

这一阶段不修改代码，也不提交和打包。

```text
现在执行“阶段 0：建立修复基线”。

本阶段只检查，不修改任何文件。

请完成：

1. 检查当前分支、git status、diff 和未跟踪文件。
2. 区分用户原有修改与仓库当前 HEAD。
3. 读取 package.json，确认：
   - 当前版本；
   - Node 版本要求。
4. 运行：
   - npm run typecheck
   - npm run lint
   - npm test
   - npm run build
   - npm run check:licenses
5. 检查 npm run format:check。
6. 如果 commit-diff-snapshot.md 仍然是未跟踪基线文件且是唯一格式问题，不要修改它，只记录。
7. 不要关闭正在运行的应用；需要运行 Electron smoke 且遇到单实例锁时先询问。
8. 输出：
   - 当前分支；
   - 当前版本；
   - 基线脏文件；
   - 测试和构建结果；
   - 是否存在与审计时不同的代码状态；
   - 后续阶段是否可以安全开始。

本阶段禁止：
- 修改文件；
- 创建提交；
- 恢复或删除基线文件。

完成报告后停止，不要开始阶段 1。
```

---

# 三、阶段 1：持久化与附件事务

覆盖缺陷：**#4、#19、#20、#21**

```text
现在执行“阶段 1：持久化、附件和 durable commit”。

严格遵守总控提示词，只处理以下四项：

1. conversation-recovery-store.ts:294
   Recovery journal 在 persist 前直接修改内存状态；persist 失败后没有回滚，后续成功保存可能把之前失败的状态写入磁盘，包括删除 encryptedPrompt。

2. chat-attachment-store.ts:302
   import 在异步准备期间，commitDraft 可以删除同一 draft；迟到 import 随后重新插入已提交 draft。

3. native-attachment-store.ts:115
   一个损坏附件使 list() 返回空数组，隐藏所有有效附件，并让后续数量和总大小计算从零开始。

4. chat-history-store.ts:494
   history 已经 durable commit，附件清理随后失败，但 public operation 仍报告整体失败，造成结果歧义和危险重试。

要求：

- 为文件系统失败、延迟 import 和单项损坏构造确定性测试。
- Recovery mutation 必须具备 copy-on-write、persist-first 或等价事务语义。
- commitDraft 和 import 必须具有同一队列、generation 或 tombstone 保护。
- Native attachment 损坏必须逐项隔离，不能使有效附件不计入限额。
- History durable commit 与附件垃圾清理必须形成明确边界。
- 如果需要改变 history cleanup 的 API/用户提示语义，先给方案并等待决定。
- 不得大改持久化文件格式。

优先检查和运行以下测试；如果文件名不同，先查找真实测试位置：

- tests/conversation-recovery-store.test.ts
- tests/chat-attachment-store.test.ts
- tests/native-attachment-store.test.ts
- tests/chat-history-store.test.ts

完成本阶段修复和验证后停止，不要开始阶段 2。
```

---

# 四、阶段 2：网络预检、DNS 与代理作用域

覆盖缺陷：**#5、#6、#22、#37**

```text
现在执行“阶段 2：网络预检、DNS 与代理作用域”。

严格遵守总控提示词，只处理：

1. network-preflight-service.ts:65
   invalidate() 增加 generation 并清 cache，却继续复用旧 in-flight Promise。

2. provider-connectivity-probe.ts:299
   CLI 已通过支持代理端 DNS 的 HTTP proxy 成功连接时，本地 DNS 失败仍被当成 required failure。

3. provider-connectivity-probe.ts:275
   dnsLookup 或 resolveProxy 不 settle 时，整个 preflight 可以无限挂起。

4. network-path-resolver.ts:139
   CLI proxy 诊断忽略 scope.cli，把 application/conversation-only 代理错误显示为 CLI 代理。

要求：

- 为 preflight generation 建立明确的取消或 supersede 语义。
- 旧 generation 的 Promise 不能返回给 invalidation 后的新调用者。
- DNS requiredness 必须根据实际网络路径判断。
- 未配置代理时保持直接连接语义，不得自动检测并启用系统代理。
- DNS、proxy resolution 和 endpoint probes 必须受到统一 overall deadline 约束。
- 所有 timeout 和 abort listener 必须清理。
- CLI 诊断必须严格尊重 scope.cli。

重点测试：

- invalidation 后立即发起同 key 请求；
- 旧请求最后完成；
- 本地 DNS 失败但显式配置的代理 endpoint 成功；
- DNS Promise 永远不完成；
- resolveProxy Promise 永远不完成；
- scope.cli=false。

优先检查：

- tests/network-preflight-service.test.ts
- tests/provider-connectivity-probe.test.ts
- tests/network-path-resolver.test.ts
- tests/proxy-contracts.test.ts

完成本阶段修复和验证后停止，不要开始阶段 3。
```

---

# 五、阶段 3：下载安全、原子替换与恢复

覆盖缺陷：**#7、#8、#23、#24**

```text
现在执行“阶段 3：下载事务、路径边界和恢复”。

严格遵守总控提示词，只处理：

1. download-engine.ts:814
   path.resolve/path.relative 的词法检查无法阻止 Windows junction/reparse point 把目标重定向到 userData 外部。

2. download-engine.ts:745
   先 unlink 旧 final，再 rename 新 partial；rename 失败后异常清理又删除 partial，最终新旧文件都丢失。

3. download-engine.ts:845
   journal 写入有节流，partial 可能比 journal 更新；恢复要求 size 完全相等并删除较新的有效 partial。

4. download-engine.ts:353
   初始 journal write 发生在 task 和 busy lease 注册后，但位于统一异常清理之外；写入失败会泄漏 task 和 lease。

要求：

- Windows junction 测试必须使用真实临时目录和 junction/reparse point，不得只 mock path.relative。
- 所有最终写入、替换、恢复和删除都必须验证真实解析后的边界。
- 原子替换失败时至少保留一个完整可恢复版本。
- 已验证的新 partial 不应在 rename 失败时被无条件删除。
- journal 落后时应安全恢复实际 partial，或截断到可信 offset，不能直接删除全部进度。
- 初始 journal 失败后 task、busy lease、listener、临时映射和 Promise 必须全部 settle。
- 不得降低完整性验证或允许跨任务恢复。

优先检查：

- tests/download-engine.test.ts
- tests/download-journal.test.ts
- tests/download-integrity.test.ts
- tests/download-contracts.test.ts
- tests/download-history.test.ts

完成本阶段修复和验证后停止，不要开始阶段 4。
```

---

# 六、阶段 4：Codex App Server 与 MCP Registry

覆盖缺陷：**#13、#14、#15、#16**

该阶段依赖阶段 2。

```text
现在执行“阶段 4：Codex App Server、登录关联和 MCP Registry 元数据”。

确认阶段 2 已完成后再开始。

只处理：

1. codex-app-server.ts:95
   Codex App Server spawn 使用原始 process.env，绕过用户在 ClaudeDock 中明确配置的 CLI proxy。

2. codex-app-server.ts:94
   stop()/dispose() 无法取消仍在等待 resolveInvocation() 的 start；旧 continuation 之后仍会 spawn。

3. codex-runtime.ts:619
   account/login/completed 没有按 loginId 关联，旧登录事件可覆盖新尝试。

4. mcp-manager.ts:186
   Registry remote 被硬编码为 http/no credential，丢失 SSE、streamable-http、required secret headers 和 URL variables。

要求：

- Codex App Server 只能接收用户明确启用且 scope.cli=true 的代理环境。
- 默认环境仍为空，不得自动启用系统代理。
- start/stop 必须有 generation 或 AbortSignal；stop 返回后旧 start 不得 spawn。
- 旧 start 不得覆盖新 child。
- login response、cancel 和 completion 全部按 loginId/attempt generation 关联。
- MCP metadata 必须端到端保留。
- 未解析的 required secret/variable 必须阻止无人值守安装。
- 测试不能写入或打印真实凭据。
- 如果要改变 MCP credential 存储方式，先提出方案并等待决定。

优先检查：

- tests/codex-app-server.test.ts
- tests/codex-runtime.test.ts
- tests/mcp-manager.test.ts
- tests/proxy-contracts.test.ts

如果 codex-app-server 的聚焦测试不存在，可以创建对应测试，但不要创建临时生产 abstraction 只为了方便 mock。

完成本阶段修复和验证后停止，不要开始阶段 5。
```

---

# 七、阶段 5：Router 所有权与 Windows 项目键

覆盖缺陷：**#11、#12、#32**

```text
现在执行“阶段 5：Router 服务所有权和 Windows 项目键”。

只处理：

1. claude-router-manager.ts:1130
   provider save/delete 没有应用 CLI-owned runtime guard，可以修改 CCR Desktop 管理的服务。

2. claude-router-manager.ts:1307
   runtime classification cache 只按 PID，PID 复用后新的 Desktop 服务可能继承旧 CLI 分类。

3. claude-config-store.ts:68
   Windows project key 使用无显式 locale 的 toLocaleLowerCase()，特殊 locale 下同一目录可能生成两个 key。

要求：

- Provider mutation 必须在任何 getConfig/saveConfig RPC 前验证 service ownership。
- Desktop-owned 或 unknown-owned 服务必须拒绝 mutation。
- 不能只依赖 PID；cache identity 至少要关联服务 token/identity、可执行文件或其他防 PID 复用的信息。
- 当 service identity 变化时必须重新分类。
- Windows 项目键必须 locale-invariant。
- 修改 project key 前先分析已有配置兼容性。
- 如果需要迁移旧 key，先提出：
  1. 只改新 key；
  2. 读旧写新；
  3. 一次性迁移；
  的利弊和推荐，然后等待我决定。
- 不得破坏已有用户 profile 和 credential 的读取。

重点测试：

- Desktop service 下 save/delete 在 RPC 前拒绝；
- CLI-owned service 正常允许；
- 相同 PID、不同服务 identity 时重新分类；
- Turkish locale 下 D:\IDE 和 d:\ide 指向同一配置；
- 旧配置兼容读取。

完成本阶段修复和验证后停止，不要开始阶段 6。
```

---

# 八、阶段 6：退出、更新安装和 Renderer 崩溃恢复

覆盖缺陷：**#2、#3、#17**

```text
现在执行“阶段 6：应用生命周期和恢复”。

只处理：

1. main.ts:677
   用户确认退出后开始不可逆 teardown；残留进程清理失败时又允许取消第二次确认，取消后应用继续运行但服务已经被拆毁。

2. main.ts:5431
   更新安装前关闭权限桥和进程服务；terminateAll 或 quitAndInstall 失败后只恢复 isQuitting。

3. main.ts:5493
   renderer 非预期崩溃时只 fallback pending permissions，没有 reload、窗口重建或恢复页面。

要求：

- 不可逆 teardown 前必须完成所有仍允许用户取消的确认。
- 如果 teardown 后仍可能返回正常应用状态，必须具有完整恢复路径。
- 更新安装流程应尽可能复用统一 controlled-quit coordinator。
- terminateAll 失败和 quitAndInstall 失败都必须测试。
- Renderer crash 恢复涉及产品选择时，先比较：
  1. reload 原 WebContents；
  2. 销毁并重建窗口；
  3. 显示安全恢复页并让用户确认；
  给出推荐后等待决定。
- 恢复只能加载可信本地 renderer URL/file。
- 不得在测试中未经允许关闭用户正在运行的应用。

重点测试：

- 第一次确认退出，残留 cleanup 失败，第二次取消；
- terminateAll 部分失败；
- quitAndInstall 同步失败；
- render-process-gone 后重新获得可交互窗口；
- pending permission 不泄漏。

优先检查：

- tests/quit-confirmation.test.ts
- tests/application-updater.test.ts
- 生命周期和窗口创建相关测试

完成本阶段修复和验证后停止，不要开始阶段 7。
```

---

# 九、阶段 8：Runtime Generation 与进程所有权

覆盖缺陷：**#29、#30、#31、#38**

```text
现在执行“阶段 8：Runtime 协调、generation 和进程所有权”。

只处理：

1. claude-runtime.ts:1864
   Relaunch G2 在所有可失败准备完成前替换 G1 permission endpoint；后续失败导致仍存活的 G1 没有可用 endpoint。

2. main-process-operation-coordinator.ts:156
   Replacement operation 在等待 predecessor cleanup 前捕获 PTY snapshot，cleanup 改变 generation 后 replacement 会错误取消自己。

3. runtime-activity-registry.ts:103
   相同 launch/PTY generation 内没有拒绝较旧 signaledAt/sequence，迟到事件可让 phase 和 observedAt 回退。

4. runtime-process-registry.ts:317
   Process scan 在 await OS snapshot 前捕获 owner，完成后不重新验证，可能发布已经过期的 owner map。

要求：

- Provisional permission endpoint 失败时不能破坏现有 committed launch。
- 可以采用 prepare/commit 或 rollback，但必须明确 endpoint ownership。
- Replacement baseline 应在 predecessor cleanup 完成后捕获，或使用等价的有效性协议。
- 同 generation 内状态必须保持 monotonic。
- 如果时间戳可能相同，使用显式 sequence，不要依赖不稳定 wall clock。
- Process snapshot 完成后重新验证 owner generation；不一致时丢弃或重跑。
- 任何 stale result 都不能覆盖新 generation。

重点测试：

- G1 存活，G2 settings 写入失败；
- predecessor cleanup 改变 PTY generation；
- Stop(200) 后迟到 Submit(100)；
- deferred process capture 期间 owner 从 A 变 B。

完成本阶段修复和验证后停止，不要开始阶段 9。
```

---

# 十、阶段 9：Native Stream、Permission Pipe 与 Terminal Transfer

覆盖缺陷：**#9、#25、#26、#27、#28**

该阶段依赖阶段 8。

```text
现在执行“阶段 9：原生会话流、权限管道和 terminal transfer”。

确认阶段 8 已完成后开始。

只处理：

1. native-conversation-service.ts:386
   terminal 已启动并 commit ownership 后，recovery bookkeeping 失败，通用 catch 又重启 native adapter。

2. chat-service.ts:1280
   OpenAI SSE 已给出 terminal finish_reason 并正常 EOF，但缺少 [DONE] 时被报告为 IncompleteChatStreamError。

3. native-conversation-service.ts:495
   onSubmissionConfirmed 同步 throw 或 Promise rejection 逃出 listener。

4. claude-agent-adapter.ts:363
   第一轮仍 streaming 时再次 submit 会清除 foreground stream lane；UUID-less partial 被拆成多个 assistant message。

5. claude-permission-bridge.ts:214
   Named-pipe 客户端正常 end/close 时 active request 不 settle，后续请求等待十分钟 timeout。

要求：

- Terminal/native transfer 必须保证任意时刻只有一个 owner。
- 如果 post-commit bookkeeping 失败后的产品行为存在选择，先比较：
  1. 保留 terminal，将 bookkeeping 错误单独上报；
  2. 先可靠停止 terminal，再恢复 native；
  然后等待决定。
- OpenAI terminal finish_reason 后 clean EOF 应正常生成且仅生成一次 done。
- 仍需把真正没有 terminal frame 的 EOF 判断为断流。
- Optional callback 的同步和异步失败都必须隔离，不能破坏主消息流。
- 对重叠 submit，先比较：
  1. running 时拒绝；
  2. per-conversation 队列；
  3. 真正并行 turn；
  给出推荐并等待决定，禁止自行选择产品语义。
- 在任何方案中，前一 turn 的 stream lane 都不得被后一 submit 破坏。
- Permission request 必须在 error、end、close、timeout、response 上幂等 settle。
- 正常 close 后下一项必须立即分发。

重点测试：

- terminal start 成功、owner commit 后 recovery reserve 失败；
- text delta + finish_reason=stop + clean EOF、无 [DONE]；
- callback 同步 throw 和异步 reject；
- UUID-less stream 的重叠 submit；
- 第一个 pipe 正常 close，第二个 request 立即分发。

完成本阶段修复和验证后停止，不要开始阶段 10。
```

---

# 十一、阶段 10：Renderer 项目和会话状态隔离

覆盖缺陷：**#1、#10、#33、#34、#39**

```text
现在执行“阶段 10：Renderer 项目/会话状态隔离和异步关联”。

只处理：

1. renderer/main.ts:10051
   MCP catalog、load promise 和卡片 callback 没有按 cwd/request generation 隔离，切换项目后可显示或修改错误项目。

2. renderer/main.ts:1394、3572、3909、12014
   Native active conversation、draft、attachments、capability revision 和 controls 是全局状态，导致：
   - 切项目仍操作旧 conversation；
   - A 的 draft/附件泄漏到 B；
   - B 显示 A 的 model/permission 状态。

3. renderer/main.ts:2607
   并发打开 history A、B 时，A 的迟到响应可覆盖最后选择的 B。

4. renderer/main.ts:11634
   Folder history 首次读取失败后缓存空结果，阻止普通重试并可能留下 loading UI。

5. renderer/main.ts:11149
   Terminal submit 因 PTY generation 改变而取消后，composer 仍清空并播放成功反馈。

要求：

- 所有异步 renderer 结果都必须关联 project/cwd、conversation ID 和 request generation。
- MCP A 的迟到结果不能在 B 中渲染或产生可点击 callback。
- Native view state 应按 conversation ID 隔离。
- 如果 draft 是否持久化存在产品选择，先提出：
  1. 仅内存 per-conversation；
  2. 持久化 per-conversation；
  3. 切换时明确丢弃并确认；
  的利弊和推荐。
- Deferred attachment import 必须携带所属 conversation generation。
- Capability cache key 不能只使用 revision 数字，至少要包含 conversation identity。
- History open 必须是 latest selection wins。
- Folder history 失败不能伪装成成功空缓存；需要可重试错误状态。
- Composer 只有在确认提交成功后才能清空；取消时保留或恢复原输入。
- 不得通过切换项目时粗暴清空所有用户草稿来掩盖状态泄漏，除非我明确选择该产品语义。

重点测试：

- MCP A pending → 切 B → A 最后完成；
- A 卡片在切 B 后不能继续操作 A；
- Native A 输入和导入附件 → 切 B → 提交 B；
- A deferred attachment 在 B 激活后完成；
- A/B capability revision 相同但 model/permission 不同；
- History A→B，B 先完成；
- Folder history 第一次失败、第二次成功；
- PTY generation 在 submit delay 中改变。

完成本阶段修复和验证后停止，不要开始阶段 11。
```

---

# 十二、阶段 11：Markdown 与 Artifact 异步 UI

覆盖缺陷：**#35、#40**

```text
现在执行“阶段 11：Markdown 和 Artifact 异步渲染”。

只处理：

1. renderer/markdown.ts:421
   同一 container 的两个 renderInto() 按异步完成顺序提交，较慢的旧渲染会覆盖较新的内容。

2. renderer/markdown.ts:560
   Artifact 第一次运行失败后，同一按钮第二次成功，按钮仍显示“运行失败”。

要求：

- 为每个可复用 container 增加 render generation、revision 或等价 latest-wins 机制。
- 旧 render 可以完成内部工作，但不得 commit 到已经进入新 generation 的 container。
- 不得全局取消所有 Markdown 渲染。
- Artifact 每次重试前恢复 running 状态。
- 成功后必须显示明确且与实际状态一致的标签。
- 失败后仍必须允许安全重试。
- 测试使用 deferred highlighter/math renderer，让 B 先完成、A 后完成。
- 测试同一按钮第一次 reject、第二次 resolve。

优先检查：

- tests/markdown.test.ts
- tests/artifact-renderer.test.ts
- 相关 renderer Markdown 测试

本阶段额外运行：

npm run test:layout
npm run test:control-theme
npm run test:select
npm run test:dialog-select
npm run test:select-theme

完成本阶段修复和验证后停止。
```

---

# 十四、三个候选问题的专项复现提示词

这三个问题没有足够的生产可达性证据，**不要和已确认的 38 项一起直接修复**。建议在所有修复阶段完成后单独执行。

```text
现在只对三个“待动态复现候选”进行生产级复现。

禁止仅凭静态代码或人工构造单元测试就修改生产代码。

候选 A：

src/main/claude-agent-adapter.ts:805

假设事件序列：

content_block_delta
→ 没有完整 assistant frame
→ 直接收到成功 result

可能结果：

conversation phase 已进入 idle，但 assistant message 永远保持 streaming。

要求：

- 优先记录真实 Claude Agent SDK 原始事件顺序；
- 检查正常完成、abort、错误和特殊 stop reason；
- 不得索要、打印或写入用户凭据；
- 如果没有可用登录环境，标记环境不足，不能声称已确认；
- 只有真实 SDK 或忠实生产 adapter harness 能产生该序列时才算确认。

候选 B：

src/renderer/claude-launch-attempt.ts:169

假设事件序列：

PTY generation 1 的 stopped/error 状态
→ generation 2 launch 已开始
→ 旧状态只按 session ID 释放当前 attempt

要求：

- 通过真实主进程 IPC 或忠实的 generation 状态生产链路延迟 G1 状态；
- 不得只直接调用 observeTerminal() 就声称生产可达；
- 记录 G1、G2 token、PTY generation 和状态投递时间线。

候选 C：

src/renderer/terminal-output-pump.ts:77

假设事件序列：

一帧以 UTF-16 high surrogate 结尾并写入 xterm
→ low surrogate 在下一帧到达

要求：

- 使用真实 ConPTY/IPC/output pump 路径；
- 输出 supplementary-plane Unicode 字符；
- 记录原始字节、IPC revision 和每次 xterm.write 内容；
- 不能只把两个 JavaScript 字符串手工 enqueue 后就声称生产可达。

统一要求：

1. 先运行相关现有测试。
2. 可以创建临时 harness，但不得提交临时文件。
3. 本阶段不修改生产代码、不创建提交。
4. 对每项输出：
   - 是否稳定复现；
   - 真实生产事件时间线；
   - 输入；
   - 错误输出；
   - 复现次数；
   - 是否依赖特殊环境；
   - 建议回归测试；
   - 建议修复方向。
5. 如果某项被稳定复现，停止在报告阶段，提出新的独立修复阶段，等待我批准后再改代码。
6. 未稳定复现的项目继续保留为候选，不得为了清空清单而强行修复。
```

---

## 建议执行顺序

```text
阶段 0：基线
阶段 1：持久化和附件
阶段 2：网络和代理
阶段 3：下载引擎
阶段 4：Codex/MCP
阶段 5：Router 所有权
阶段 6：应用生命周期
阶段 7：Runtime generation
阶段 8：Native/permission/terminal
阶段 9：Renderer 状态隔离
阶段 10：Markdown/Artifact
候选专项动态复现
```

其中必须保持两条依赖关系：

- **阶段 2 完成后再做阶段 4**，因为 Codex proxy 应复用阶段 2 明确下来的代理作用域和环境构建规则。
- **阶段 8 完成后再做阶段 9**，因为 native transfer、permission endpoint 和 overlapping stream 都依赖正确的 runtime generation/ownership 基础。
