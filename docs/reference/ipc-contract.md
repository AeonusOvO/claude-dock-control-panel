# IPC 契约

渲染进程与主进程之间的全部通道，以及它们与 `ControlPanelApi` 方法的映射。

## 通道形态

| 形态     | 方向                       | 渲染端                    | 主进程             | 数量 |
| -------- | -------------------------- | ------------------------- | ------------------ | ---- |
| 请求响应 | renderer → main → renderer | `ipcRenderer.invoke`      | `ipcMain.handle`   | 184  |
| 单向命令 | renderer → main            | `ipcRenderer.send`        | `ipcMain.on`       | 7    |
| 事件推送 | main → renderer            | `ipcRenderer.on`          | `webContents.send` | 24   |
| 非 IPC   | 进程内                     | `webUtils.getPathForFile` | —                  | 1    |

`ControlPanelApi` 共 215 个成员：184 请求响应 + 24 事件订阅 + 6 单向命令 + 1 非 IPC。第 7 个单向通道 `app:quit-request-received` 由 `onAppQuitRequested` 的回调内部发出，不占独立方法位。

## 当前实现位置

| 内容         | 位置                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 频道常量     | `src/shared/ipc/channels.ts`（215 个常量，REQUEST/SEND/EVENT 三组，派生频道类型与冻结数组）                                                    |
| 参数 schema  | `src/shared/ipc/schema.ts` + `claude-execution-settings-schema.ts`                                                                             |
| 类型定义     | `src/shared/contracts/`（21 个域文件 + `control-panel-api.ts` + `index.ts` 桶文件）                                                            |
| API 组合     | `src/shared/contracts/control-panel-api.ts`（21 个域接口组合出 215 个成员）                                                                    |
| 渲染端桥     | `src/preload/index.ts`（单点 `contextBridge.exposeInMainWorld`）+ `src/preload/bridges/` 21 个桥文件                                           |
| 主进程注册   | `src/main/ipc/`（31 个文件：25 个域注册 + 贡献点机制 + 守卫 + 校验 + 共享上下文）                                                              |
| 注册组合     | `src/main/ipc/index.ts`（`registerIpc(dependencies)`；`MAIN_IPC_CONTRIBUTIONS` 25 个贡献项，`UnionToIntersection` 派生 `MainIpcDependencies`） |
| 参数校验     | `src/main/ipc/validation.ts`（`validate*()` 由 `schema.ts` 的 schema 派生）                                                                    |
| 发送者守卫   | `src/main/ipc/guards.ts`（`validateSender` 拒绝非主窗口来源；另含运行时效果断言与服务解析器）                                                  |
| 插件变更通道 | `src/main/ipc/claude-plugin.ts` 的 `pluginMutations` Map，8 个通道循环注册，共用 `runPluginMutation` 包装                                      |

preload 由 `vite.preload.config.ts` 从 `src/preload/index.ts` 构建为单 CJS 入口 `dist/preload/preload.js`（沙箱 preload 无法 require 相邻文件，桥图必须打成单一产物）。

## 约束

- 频道名只能引用 `src/shared/ipc/channels.ts` 的 `CHANNELS` 常量，preload 与 main 两侧不写裸字符串字面量。
- 每个 `ipcMain.handle` 与 `ipcMain.on` 首先调用 `validateSender(event)`，拒绝非主窗口 `webContents` 的调用。
- 参数以 `unknown` 接收，经 `validate*()` 函数收窄后才进入业务代码。
- preload 只导出白名单方法，不导出 `ipcRenderer` 本体，不透传任意频道名。
- 事件订阅方法返回取消函数，内部调用 `removeListener`。
- 渲染进程与主进程共享的类型只来自 `src/shared/`。

## 请求响应频道（184）

### `app`（14）

| 频道                                          | 方法                                 |
| --------------------------------------------- | ------------------------------------ |
| `app:get-settings`                            | `getAppSettings`                     |
| `app:get-startup-model-connection`            | `getStartupModelConnection`          |
| `app:get-diagnostics`                         | `getDiagnostics`                     |
| `app:cancel-startup-model-connection`         | `cancelStartupModelConnection`       |
| `app:set-launch-at-login`                     | `setLaunchAtLogin`                   |
| `app:set-footer-resource-preference`          | `setFooterResourcePreference`        |
| `app:set-managed-chatgpt-context-window-mode` | `setManagedChatGptContextWindowMode` |
| `app:set-claude-context-window-mode`          | `setClaudeContextWindowMode`         |
| `app:set-advanced-settings`                   | `setAdvancedSettings`                |
| `app:set-close-behavior`                      | `setCloseBehavior`                   |
| `app:set-conversation-resume-preferences`     | `setConversationResumePreferences`   |
| `app:open-external`                           | `openExternal`                       |
| `app:clipboard-read`                          | `readClipboardText`                  |
| `app:clipboard-write`                         | `writeClipboardText`                 |

`app:set-advanced-settings` 的结构化参数包含 `networkPreflight.checkOnNewSession`、
`checkOnProviderLogin` 及可选的 CLI-only `cliTimezone` / `cliLanguages`。主进程校验 IANA 时区和
BCP-47 语言后原子保存；它不接受任意环境变量名，也不修改 Windows 系统设置。

### `onboarding`（5）

| 频道                  | 方法                       | 作用                     |
| --------------------- | -------------------------- | ------------------------ |
| `onboarding:get`      | `getOnboardingState`       | 读取版本化本地进度       |
| `onboarding:update`   | `updateOnboardingProgress` | 保存引擎、模型来源与步骤 |
| `onboarding:complete` | `completeOnboarding`       | 校验选择并标记完成       |
| `onboarding:skip`     | `skipOnboarding`           | 标记跳过，后续不自动遮挡 |
| `onboarding:reset`    | `resetOnboarding`          | 从设置或空工作区重新开始 |

五个 handler 都先校验 sender；步骤、引擎、模型来源和国产 provider ID 由 `OnboardingStore` 白名单校验。
存储只包含版本、状态、选择与更新时间，不接受凭据、自由模型 ID 或项目正文。

### `workspace`（3）

| 频道                              | 方法                  |
| --------------------------------- | --------------------- |
| `workspace:get-state`             | `getWorkspace`        |
| `workspace:get-stored-projects`   | `getStoredProjects`   |
| `workspace:remove-stored-project` | `removeStoredProject` |

### `project`（8）

| 频道                               | 方法                     |
| ---------------------------------- | ------------------------ |
| `project:activate`                 | `activateProject`        |
| `project:add`                      | `addProject`             |
| `project:close`                    | `closeProject`           |
| `project:close-folder`             | `closeProjectFolder`     |
| `project:open-conversation`        | `openConversation`       |
| `project:open-stored-conversation` | `openStoredConversation` |
| `project:rename-conversation`      | `renameConversation`     |
| `project:forget`                   | `forgetProject`          |

### `directory`（1）

| 频道               | 方法              |
| ------------------ | ----------------- |
| `directory:choose` | `chooseDirectory` |

### `terminal`（3）

| 频道               | 方法              |
| ------------------ | ----------------- |
| `terminal:start`   | `startTerminal`   |
| `terminal:restart` | `restartTerminal` |
| `terminal:stop`    | `stopTerminal`    |

### `claude`（60）

| 频道                                             | 方法                                    |
| ------------------------------------------------ | --------------------------------------- |
| `claude:get-state`                               | `getClaudeProjectState`                 |
| `claude:get-next-connection`                     | `getNextClaudeConnection`               |
| `claude:launch`                                  | `launchClaude`                          |
| `claude:relaunch`                                | `relaunchClaudeSession`                 |
| `claude:command`                                 | `runClaudeCommand`                      |
| `claude:save-config`                             | `saveClaudeConfig`                      |
| `claude:save-next-config`                        | `saveNextClaudeConfig`                  |
| `claude:test-connection`                         | `testClaudeConnection`                  |
| `claude:test-next-connection`                    | `testNextClaudeConnection`              |
| `claude:get-connection-advice`                   | `getClaudeConnectionAdvice`             |
| `claude:get-gateway-diagnostics`                 | `getClaudeGatewayDiagnostics`           |
| `claude:model-options`                           | `getClaudeModelOptions`                 |
| `claude:switch-model`                            | `switchClaudeModel`                     |
| `claude:set-model-speed`                         | `setClaudeModelSpeed`                   |
| `claude:set-effort`                              | `setClaudeEffortLevel`                  |
| `claude:set-permission-mode`                     | `setClaudePermissionMode`               |
| `claude:set-allow-bypass-permissions`            | `setClaudeAllowBypassPermissions`       |
| `claude:permission-response`                     | `respondClaudePermission`               |
| `claude:provider-models-discover`                | `discoverClaudeProviderModels`          |
| `claude:connection-history`                      | `getClaudeConnectionHistory`            |
| `claude:connection-history-apply`                | `applyClaudeConnectionHistory`          |
| `claude:connection-history-cancel-apply`         | `cancelClaudeConnectionHistoryApply`    |
| `claude:connection-history-delete`               | `deleteClaudeConnectionHistory`         |
| `claude:connection-history-rename`               | `renameClaudeConnectionHistory`         |
| `claude:conversation-model-inspect`              | `inspectClaudeConversationModel`        |
| `claude:conversation-model-apply`                | `applyClaudeConversationModel`          |
| `claude:get-sessions`                            | `getClaudeSessions`                     |
| `claude:get-sessions-for-path`                   | `getClaudeSessionsForPath`              |
| `claude:launch-with-session`                     | `launchClaudeWithSession`               |
| `claude:rename-session`                          | `renameClaudeSession`                   |
| `claude:delete-session`                          | `deleteClaudeSession`                   |
| `claude:execution-settings-get`                  | `getClaudeExecutionSettings`            |
| `claude:execution-settings-update`               | `updateClaudeExecutionSettings`         |
| `claude:execution-settings-use-recommended`      | `useRecommendedClaudeExecutionSettings` |
| `claude:execution-settings-restore-default`      | `restoreClaudeExecutionSettingsDefault` |
| `claude:launch-preflight-decide`                 | `decideClaudeLaunchPreflight`           |
| `claude:router-get-state`                        | `getClaudeRouterManagementState`        |
| `claude:router-install`                          | `installClaudeRouter`                   |
| `claude:router-install-source`                   | `installClaudeRouterFromSource`         |
| `claude:router-uninstall`                        | `uninstallClaudeRouter`                 |
| `claude:router-start`                            | `startClaudeRouter`                     |
| `claude:router-stop`                             | `stopClaudeRouter`                      |
| `claude:router-open-management`                  | `openClaudeRouterManagement`            |
| `claude:router-save-provider`                    | `saveClaudeRouterProvider`              |
| `claude:router-delete-provider`                  | `deleteClaudeRouterProvider`            |
| `claude:router-repair-from-project`              | `repairClaudeRouterFromProject`         |
| `claude:managed-chatgpt-gateway-state`           | `getManagedChatGptGatewayState`         |
| `claude:managed-chatgpt-gateway-logout`          | `logoutManagedChatGptGateway`           |
| `claude:managed-chatgpt-gateway-setup`           | `setupManagedChatGptGateway`            |
| `claude:managed-chatgpt-gateway-cancel-setup`    | `cancelManagedChatGptGatewaySetup`      |
| `claude:managed-chatgpt-gateway-model`           | `setManagedChatGptGatewayModel`         |
| `claude:managed-chatgpt-gateway-open-management` | `openManagedChatGptGatewayManagement`   |
| `claude:plugins-get`                             | `getClaudePlugins`                      |
| `claude:plugins-install`                         | `installClaudePlugin`                   |
| `claude:plugins-uninstall`                       | `uninstallClaudePlugin`                 |
| `claude:plugins-update`                          | `updateClaudePlugin`                    |
| `claude:plugins-update-all`                      | `updateAllClaudePlugins`                |
| `claude:plugins-set-enabled`                     | `setClaudePluginEnabled`                |
| `claude:plugins-marketplace-add`                 | `addClaudePluginMarketplace`            |
| `claude:plugins-marketplace-remove`              | `removeClaudePluginMarketplace`         |
| `claude:plugins-marketplaces-refresh`            | `refreshClaudePluginMarketplaces`       |

后 8 个 `claude:plugins-*` 变更通道由 `pluginMutations` Map 循环注册，共用同一个 `runPluginMutation` 包装。

### `codex`（6）

| 频道                   | 方法                   |
| ---------------------- | ---------------------- |
| `codex:get-state`      | `getCodexProjectState` |
| `codex:install-update` | `installOrUpdateCodex` |
| `codex:login-start`    | `startCodexLogin`      |
| `codex:login-cancel`   | `cancelCodexLogin`     |
| `codex:logout`         | `logoutCodex`          |
| `codex:launch`         | `launchCodex`          |

### `native-conversation`（14）

| 频道                                       | 方法                                   |
| ------------------------------------------ | -------------------------------------- |
| `native-conversation:start`                | `startNativeConversation`              |
| `native-conversation:get`                  | `getNativeConversation`                |
| `native-conversation:submit`               | `submitNativeConversation`             |
| `native-conversation:respond`              | `respondNativeConversation`            |
| `native-conversation:interrupt`            | `interruptNativeConversation`          |
| `native-conversation:stop-task`            | `stopNativeConversationTask`           |
| `native-conversation:update-controls`      | `updateNativeConversationControls`     |
| `native-conversation:close`                | `closeNativeConversation`              |
| `native-conversation:rename`               | `renameNativeConversation`             |
| `native-conversation:transfer-to-terminal` | `transferNativeConversationToTerminal` |
| `native-conversation:adopt-terminal`       | `adoptTerminalConversation`            |
| `native-conversation:list-recoveries`      | `listNativeRecoveries`                 |
| `native-conversation:restore-draft`        | `restoreNativeDraft`                   |
| `native-conversation:discard-recovery`     | `discardNativeRecovery`                |

### `native-attachment`（5）

| 频道                                 | 方法                          |
| ------------------------------------ | ----------------------------- |
| `native-attachment:import-paths`     | `importNativeAttachmentPaths` |
| `native-attachment:import-bytes`     | `importNativeAttachmentBytes` |
| `native-attachment:import-clipboard` | `importNativeClipboardImage`  |
| `native-attachment:read`             | `readNativeAttachment`        |
| `native-attachment:remove`           | `removeNativeAttachment`      |

### `chat`（17）

| 频道                            | 方法                         |
| ------------------------------- | ---------------------------- |
| `chat:get-config`               | `getChatConfig`              |
| `chat:save-config`              | `saveChatConfig`             |
| `chat:test-connection`          | `testChatConnection`         |
| `chat:preflight`                | `preflightChat`              |
| `chat:start`                    | `startChat`                  |
| `chat:stop`                     | `stopChat`                   |
| `chat:list-conversations`       | `getChatConversations`       |
| `chat:get-conversation`         | `getChatConversation`        |
| `chat:save-conversation`        | `saveChatConversation`       |
| `chat:rename-conversation`      | `renameChatConversation`     |
| `chat:delete-conversation`      | `deleteChatConversation`     |
| `chat:import-attachments`       | `importChatAttachments`      |
| `chat:import-attachment-bytes`  | `importChatAttachmentBytes`  |
| `chat:import-clipboard-image`   | `importChatClipboardImage`   |
| `chat:read-attachment`          | `readChatAttachment`         |
| `chat:delete-draft-attachment`  | `deleteChatDraftAttachment`  |
| `chat:release-attachment-draft` | `releaseChatAttachmentDraft` |

### `markdown`（1）

| 频道                     | 方法                   |
| ------------------------ | ---------------------- |
| `markdown:open-external` | `openMarkdownExternal` |

### `artifact`（4）

| 频道                           | 方法                        |
| ------------------------------ | --------------------------- |
| `artifact:create`              | `createArtifact`            |
| `artifact:destroy`             | `destroyArtifact`           |
| `artifact:get-network-state`   | `getArtifactNetworkState`   |
| `artifact:set-network-allowed` | `setArtifactNetworkAllowed` |

### `router`（4）

| 频道                              | 方法                              |
| --------------------------------- | --------------------------------- |
| `router:kernel-state`             | `getRouterKernelState`            |
| `router:cc-switch-install`        | `installCcSwitch`                 |
| `router:cc-switch-uninstall`      | `uninstallCcSwitch`               |
| `router:cc-switch-export-current` | `exportCurrentProviderToCcSwitch` |

### `network-preflight`（5）

| 频道                              | 方法                           |
| --------------------------------- | ------------------------------ |
| `network-preflight:get`           | `getNetworkPreflight`          |
| `network-preflight:run`           | `runNetworkPreflight`          |
| `network-preflight:invalidate`    | `invalidateNetworkPreflight`   |
| `network-preflight:get-history`   | `getNetworkPreflightHistory`   |
| `network-preflight:clear-history` | `clearNetworkPreflightHistory` |

### `application-proxy`（4）

| 频道                       | 方法                               |
| -------------------------- | ---------------------------------- |
| `application-proxy:get`    | `getApplicationProxyState`         |
| `application-proxy:save`   | `saveApplicationProxy`             |
| `application-proxy:test`   | `testApplicationProxy`             |
| `application-proxy:detect` | `detectApplicationProxyCandidates` |

### `mcp`（8）

| 频道                 | 方法               |
| -------------------- | ------------------ |
| `mcp:get-catalog`    | `getMcpCatalog`    |
| `mcp:install`        | `installMcpServer` |
| `mcp:remove`         | `removeMcpServer`  |
| `mcp:toggle-preview` | `previewMcpToggle` |
| `mcp:toggle-apply`   | `applyMcpToggle`   |
| `mcp:toggle-discard` | `discardMcpToggle` |
| `mcp:backups`        | `getMcpBackups`    |
| `mcp:backup-restore` | `restoreMcpBackup` |

### `download`（6）

| 频道                      | 方法                    |
| ------------------------- | ----------------------- |
| `download:list`           | `listDownloads`         |
| `download:pause`          | `pauseDownload`         |
| `download:resume`         | `resumeDownload`        |
| `download:cancel`         | `cancelDownload`        |
| `download:history-delete` | `deleteDownloadHistory` |
| `download:history-clear`  | `clearDownloadHistory`  |

### `software`（5）

| 频道                                    | 方法                         |
| --------------------------------------- | ---------------------------- |
| `software:updates-get`                  | `getSoftwareUpdates`         |
| `software:claude-install-update`        | `installOrUpdateClaudeCode`  |
| `software:application-updater-get`      | `getApplicationUpdaterState` |
| `software:application-updater-download` | `downloadApplicationUpdate`  |
| `software:application-updater-install`  | `installApplicationUpdate`   |

`software:application-updater-get` 的刷新参数始终是 check-only。只有显式调用
`software:application-updater-download` 才授权本次交易下载；当 electron-updater 完成下载与 SHA-512
校验后，主进程会合并并发请求、清理自有进程并自动退出安装。`software:application-updater-install`
保留为已下载状态的兼容入口，正常界面不再要求用户二次点击；NSIS 以静默模式安装，完成后重新启动
ClaudeDock。

### `runtime`（6）

| 频道                        | 方法                        |
| --------------------------- | --------------------------- |
| `runtime:get`               | `getDevelopmentRuntime`     |
| `runtime:set`               | `setDevelopmentRuntime`     |
| `runtime:get-next`          | `getNextDevelopmentRuntime` |
| `runtime:set-next`          | `setNextDevelopmentRuntime` |
| `runtime:get-activity`      | `getRuntimeActivity`        |
| `runtime:terminate-process` | `terminateRuntimeProcess`   |

### `busy`（3）

| 频道                            | 方法                         |
| ------------------------------- | ---------------------------- |
| `busy:list`                     | `listBusyLeases`             |
| `busy:set-conversation`         | `setConversationBusy`        |
| `busy:set-workspace-transition` | `setWorkspaceTransitionBusy` |

### `ui`（1）

| 频道           | 方法          |
| -------------- | ------------- |
| `ui:set-theme` | `setAppTheme` |

## 单向命令频道（7）

`ipcRenderer.send` → `ipcMain.on`，无返回值。前四个是高频写入，走单向以避免每次按键都产生一次 Promise 往返。

| 频道                                  | 方法                              | 载荷                                                           |
| ------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `terminal:write`                      | `writeTerminal`                   | `sessionId`、`ptyGeneration`、`data`                           |
| `terminal:resize`                     | `resizeTerminal`                  | `sessionId`、`ptyGeneration`、`resizeRevision`、`cols`、`rows` |
| `claude:permission-mode-observed`     | `observeClaudePermissionMode`     | `sessionId`、`ptyGeneration`、`mode`                           |
| `claude:permission-mode-probe-result` | `reportClaudePermissionModeProbe` | `sessionId`、`ptyGeneration`、`probeId`、`mode`                |
| `app:minimize-to-tray`                | `minimizeToTray`                  | 无                                                             |
| `app:confirm-quit`                    | `confirmQuit`                     | `confirmed`                                                    |
| `app:quit-request-received`           | `onAppQuitRequested` 回调内部     | 无                                                             |

`ptyGeneration` 与 `resizeRevision` 是版本号：终端重启后旧帧的写入与尺寸事件会带着过期版本抵达，主进程按版本丢弃。
`TerminalStatus.size` 携带该 PTY 已采纳的 `{ cols, rows }`，renderer 必须在新建 xterm、解析输出前使用它。
同一显示区域的尺寸一次测量后分发给前后台各个 generation；`terminal:size` 回声若早于 view 已发送的
最新 `resizeRevision` 则直接忽略，不允许迟到回声覆盖最大化后的新尺寸。

## 事件频道（24）

`webContents.send` → `ipcRenderer.on`。订阅方法返回取消函数。

| 频道                                    | 订阅方法                          |
| --------------------------------------- | --------------------------------- |
| `app:open-download-center`              | `onOpenDownloadCenterRequested`   |
| `app:quit-requested`                    | `onAppQuitRequested`              |
| `app:quit-request-invalidated`          | `onAppQuitRequestInvalidated`     |
| `app:window-restored`                   | `onAppWindowRestored`             |
| `app:startup-model-connection-changed`  | `onStartupModelConnectionChanged` |
| `application-proxy:changed`             | `onApplicationProxyChanged`       |
| `artifact:network-log`                  | `onArtifactNetworkLog`            |
| `busy:changed`                          | `onBusyChanged`                   |
| `chat:stream`                           | `onChatStream`                    |
| `claude:managed-chatgpt-setup-progress` | `onManagedChatGptSetupProgress`   |
| `claude:permission-mode-probe`          | `onClaudePermissionModeProbe`     |
| `claude:permission-request`             | `onClaudePermissionRequest`       |
| `claude:state`                          | `onClaudeState`                   |
| `codex:state`                           | `onCodexState`                    |
| `conversation:owner-conflict`           | `onConversationOwnerConflict`     |
| `download:changed`                      | `onDownloadsChanged`              |
| `native-conversation:snapshot`          | `onNativeConversation`            |
| `network-preflight:result`              | `onNetworkPreflight`              |
| `router:operation-progress`             | `onRouterOperationProgress`       |
| `runtime:activity-changed`              | `onRuntimeActivityChanged`        |
| `software:application-updater-changed`  | `onApplicationUpdaterChanged`     |
| `terminal:data`                         | `onTerminalData`                  |
| `terminal:size`                         | `onTerminalSize`                  |
| `workspace:state`                       | `onWorkspaceState`                |

`StartupModelConnectionState` 的 `updatedAt` 保持单调；活动事务可同时携带 `step` 与脱敏的
`accountLabel`。`step` 只描述当前事务阶段，`accountLabel` 只用于 Claude 官方订阅或 ChatGPT 官方订阅
的 provider/账户呈现，不得包含令牌、密钥或原始登录响应。

`WorkspaceState.revision` 由 main 在每次 `workspace:state` 广播前递增，同步请求返回当前值。renderer
必须拒绝小于已接受 revision 的迟到快照；字段保持可选只用于旧夹具与兼容读取，当前 main 始终提供。

## 非 IPC 方法（1）

| 方法             | 实现                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| `getDroppedPath` | `webUtils.getPathForFile(file)`，在 preload 内同步返回拖放文件的本机路径，不经过主进程 |

## 新增频道的步骤

### 自动接入载荷

`claude:save-next-config`、`claude:test-next-connection`、`chat:save-config` 与 `chat:test-connection`
复用既有通道，接收可选 `autoDetect: true`。这是请求参数，不作为持久化的已验证标记。
main 重新解析服务商、地址、密钥和在线模型，只在成功后保存；测试通道不保存。
Claude 保存结果可携带 `connectionTest`，renderer 不再先测后另发保存。会话级 `claude:save-config`
拒绝自动载荷。Chat 视图另返回可选 `preset`，协议增加 `openai-responses`；已保存密钥仍只返回 configured 状态。

### 扩展通道

1. 在 `src/shared/ipc/channels.ts` 的对应组（请求响应/单向命令/事件）加频道常量。
2. 在 `src/shared/contracts/control-panel-api.ts` 的对应域接口加方法签名，参数与返回值类型加在同域的 `src/shared/contracts/<domain>.ts`。
3. 在 `src/preload/bridges/<domain>.ts` 加对应桥方法，频道引用 `CHANNELS` 常量。
4. 在 `src/main/ipc/<domain>.ts` 注册 `ipcMain.handle`，首行 `validateSender(event)`，参数用 `src/main/ipc/validation.ts` 的 `validate*()` 收窄（新的参数形状先在 `src/shared/ipc/schema.ts` 加 schema）；处理器需要的依赖加进同文件的 `XxxIpcDependencies` 接口。新域还需在 `src/main/ipc/contributions.ts` 的 `MAIN_IPC_CONTRIBUTIONS` 加贡献项。
5. 更新本文对应小节的表格。
