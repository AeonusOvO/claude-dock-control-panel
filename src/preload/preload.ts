import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ClaudeConfigResult,
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionHistoryResult,
  ClaudeConnectionTestResult,
  ClaudeEffortRequest,
  ClaudeGatewayDiagnostics,
  ClaudeModelOptions,
  ClaudeOperationResult,
  ClaudePermissionMode,
  ClaudePluginCatalog,
  ClaudePluginOperationResult,
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  RouterKernelState,
  ClaudeSessionMetadata,
  ArtifactNetworkLogEntry,
  AppQuitRequest,
  BusyLease,
  ChatStreamEvent,
  CodexProjectState,
  ControlPanelApi,
  DirectoryChoiceResult,
  DownloadTaskView,
  McpCatalog,
  McpBackupView,
  McpOperationResult,
  McpTogglePreview,
  ProxyAuditRecord,
  ProxyControlView,
  ProxyImportPreview,
  OperationResult,
  WorkspaceProject,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';

const api: ControlPanelApi = {
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:set-launch-at-login', enabled),
  setAdvancedSettings: (settings) => ipcRenderer.invoke('app:set-advanced-settings', settings),
  setCloseBehavior: (behavior) => ipcRenderer.invoke('app:set-close-behavior', behavior),
  listBusyLeases: () => ipcRenderer.invoke('busy:list') as Promise<BusyLease[]>,
  onBusyChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, leases: BusyLease[]): void => {
      listener(leases);
    };
    ipcRenderer.on('busy:changed', callback);
    return () => {
      ipcRenderer.removeListener('busy:changed', callback);
    };
  },
  setConversationBusy: (busy) => ipcRenderer.invoke('busy:set-conversation', busy),
  cancelDownload: (taskId) => ipcRenderer.invoke('download:cancel', taskId),
  listDownloads: () => ipcRenderer.invoke('download:list') as Promise<DownloadTaskView[]>,
  onDownloadsChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, tasks: DownloadTaskView[]): void => {
      listener(tasks);
    };
    ipcRenderer.on('download:changed', callback);
    return () => {
      ipcRenderer.removeListener('download:changed', callback);
    };
  },
  pauseDownload: (taskId) => ipcRenderer.invoke('download:pause', taskId),
  resumeDownload: (taskId) => ipcRenderer.invoke('download:resume', taskId),
  getProxyState: () => ipcRenderer.invoke('proxy:get-state') as Promise<ProxyControlView>,
  previewProxyImport: (text) =>
    ipcRenderer.invoke('proxy:preview-import', text) as Promise<ProxyImportPreview>,
  previewProxySubscription: (url) =>
    ipcRenderer.invoke('proxy:preview-subscription', url) as Promise<ProxyImportPreview>,
  saveProxyProfiles: (profiles, subscription) =>
    ipcRenderer.invoke('proxy:save-profiles', profiles, subscription),
  refreshProxySubscriptions: () => ipcRenderer.invoke('proxy:refresh-subscriptions'),
  removeProxyProfile: (profileId) => ipcRenderer.invoke('proxy:remove-profile', profileId),
  selectProxyProfile: (profileId) => ipcRenderer.invoke('proxy:select-profile', profileId),
  setProxyScope: (scope) => ipcRenderer.invoke('proxy:set-scope', scope),
  probeProxyCoreSources: () => ipcRenderer.invoke('proxy:probe-core-sources'),
  installProxyCore: () => ipcRenderer.invoke('proxy:install-core'),
  installProxyCoreFile: (filePath) => ipcRenderer.invoke('proxy:install-core-file', filePath),
  detectBootstrapProxyCandidates: () =>
    ipcRenderer.invoke('proxy:detect-bootstrap-proxy') as Promise<string[]>,
  startBuiltInProxy: (manualCorePath, acceptExternalTunnelChain) =>
    ipcRenderer.invoke('proxy:start', manualCorePath, acceptExternalTunnelChain),
  stopBuiltInProxy: () => ipcRenderer.invoke('proxy:stop'),
  testBuiltInProxyPerformance: () => ipcRenderer.invoke('proxy:test-performance'),
  runProxyLeakAudit: () => ipcRenderer.invoke('proxy:run-audit'),
  acceptProxyLeakAudit: (recordId) => ipcRenderer.invoke('proxy:accept-audit', recordId),
  deleteProxyLeakAudit: (recordId) => ipcRenderer.invoke('proxy:delete-audit', recordId),
  getWindowsIpv6State: () => ipcRenderer.invoke('network:get-ipv6-state'),
  setWindowsIpv6Disabled: (disabled) => ipcRenderer.invoke('network:set-ipv6-disabled', disabled),
  onProxyStateChanged: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ProxyControlView): void => {
      listener(state);
    };
    ipcRenderer.on('proxy:state-changed', callback);
    return () => ipcRenderer.removeListener('proxy:state-changed', callback);
  },
  onProxyAuditRequired: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, record: ProxyAuditRecord): void => {
      listener(record);
    };
    ipcRenderer.on('proxy:audit-required', callback);
    return () => ipcRenderer.removeListener('proxy:audit-required', callback);
  },
  createArtifact: (html) => ipcRenderer.invoke('artifact:create', html),
  destroyArtifact: (artifactId) => ipcRenderer.invoke('artifact:destroy', artifactId),
  getArtifactNetworkState: () => ipcRenderer.invoke('artifact:get-network-state'),
  setArtifactNetworkAllowed: (allowed) =>
    ipcRenderer.invoke('artifact:set-network-allowed', allowed),
  onArtifactNetworkLog: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, entry: ArtifactNetworkLogEntry): void => {
      listener(entry);
    };
    ipcRenderer.on('artifact:network-log', callback);
    return () => {
      ipcRenderer.removeListener('artifact:network-log', callback);
    };
  },
  getChatConfig: () => ipcRenderer.invoke('chat:get-config'),
  saveChatConfig: (input) => ipcRenderer.invoke('chat:save-config', input),
  testChatConnection: (input) => ipcRenderer.invoke('chat:test-connection', input),
  importChatAttachments: (input) => ipcRenderer.invoke('chat:import-attachments', input),
  importChatAttachmentBytes: (input) => ipcRenderer.invoke('chat:import-attachment-bytes', input),
  readChatAttachment: (attachmentId) => ipcRenderer.invoke('chat:read-attachment', attachmentId),
  deleteChatDraftAttachment: (draftId, attachmentId) =>
    ipcRenderer.invoke('chat:delete-draft-attachment', draftId, attachmentId),
  releaseChatAttachmentDraft: (draftId) =>
    ipcRenderer.invoke('chat:release-attachment-draft', draftId),
  getChatConversations: () => ipcRenderer.invoke('chat:list-conversations'),
  getChatConversation: (conversationId) =>
    ipcRenderer.invoke('chat:get-conversation', conversationId),
  saveChatConversation: (input) => ipcRenderer.invoke('chat:save-conversation', input),
  renameChatConversation: (conversationId, title) =>
    ipcRenderer.invoke('chat:rename-conversation', conversationId, title),
  deleteChatConversation: (conversationId) =>
    ipcRenderer.invoke('chat:delete-conversation', conversationId),
  preflightChat: (input) => ipcRenderer.invoke('chat:preflight', input),
  startChat: (input) => ipcRenderer.invoke('chat:start', input),
  stopChat: (requestId) => ipcRenderer.invoke('chat:stop', requestId) as Promise<void>,
  onChatStream: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, streamEvent: ChatStreamEvent): void => {
      listener(streamEvent);
    };
    ipcRenderer.on('chat:stream', callback);
    return () => {
      ipcRenderer.removeListener('chat:stream', callback);
    };
  },
  getNetworkPreflight: (provider) => ipcRenderer.invoke('network-preflight:get', provider),
  runNetworkPreflight: (input) => ipcRenderer.invoke('network-preflight:run', input),
  invalidateNetworkPreflight: (reason) =>
    ipcRenderer.invoke('network-preflight:invalidate', reason),
  getNetworkPreflightSettings: () => ipcRenderer.invoke('network-preflight:get-settings'),
  setNetworkPreflightSettings: (settings) =>
    ipcRenderer.invoke('network-preflight:set-settings', settings),
  getNetworkPreflightHistory: () => ipcRenderer.invoke('network-preflight:get-history'),
  clearNetworkPreflightHistory: () => ipcRenderer.invoke('network-preflight:clear-history'),
  onNetworkPreflight: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      result: Parameters<typeof listener>[0],
    ): void => {
      listener(result);
    };
    ipcRenderer.on('network-preflight:result', callback);
    return () => {
      ipcRenderer.removeListener('network-preflight:result', callback);
    };
  },
  openMarkdownExternal: (url) => ipcRenderer.invoke('markdown:open-external', url),
  activateProject: (sessionId: string) =>
    ipcRenderer.invoke('project:activate', sessionId) as Promise<WorkspaceResult>,
  addProject: (directoryPath: string) =>
    ipcRenderer.invoke('project:add', directoryPath) as Promise<WorkspaceResult>,
  chooseDirectory: () => ipcRenderer.invoke('directory:choose') as Promise<DirectoryChoiceResult>,
  closeProject: (sessionId: string) =>
    ipcRenderer.invoke('project:close', sessionId) as Promise<WorkspaceResult>,
  closeProjectFolder: (projectPath: string) =>
    ipcRenderer.invoke('project:close-folder', projectPath) as Promise<WorkspaceResult>,
  openConversation: (projectPath: string) =>
    ipcRenderer.invoke('project:open-conversation', projectPath) as Promise<WorkspaceResult>,
  openStoredConversation: (projectPath: string, conversationId: string) =>
    ipcRenderer.invoke(
      'project:open-stored-conversation',
      projectPath,
      conversationId,
    ) as Promise<WorkspaceResult>,
  renameConversation: (sessionId: string, title: string) =>
    ipcRenderer.invoke('project:rename-conversation', sessionId, title) as Promise<WorkspaceResult>,
  forgetProject: (projectPath: string) =>
    ipcRenderer.invoke('project:forget', projectPath) as Promise<WorkspaceResult>,
  getClaudeProjectState: (sessionId: string) =>
    ipcRenderer.invoke('claude:get-state', sessionId) as Promise<ClaudeProjectState>,
  getClaudeGatewayDiagnostics: (sessionId: string) =>
    ipcRenderer.invoke(
      'claude:get-gateway-diagnostics',
      sessionId,
    ) as Promise<ClaudeGatewayDiagnostics>,
  getClaudeRouterManagementState: (sessionId: string) =>
    ipcRenderer.invoke(
      'claude:router-get-state',
      sessionId,
    ) as Promise<ClaudeRouterManagementState>,
  getClaudeConnectionAdvice: (sessionId: string) =>
    ipcRenderer.invoke(
      'claude:get-connection-advice',
      sessionId,
    ) as Promise<ClaudeConnectionAdvice>,
  getClaudeConnectionHistory: (sessionId: string) =>
    ipcRenderer.invoke('claude:connection-history', sessionId) as Promise<
      ClaudeConnectionHistoryEntry[]
    >,
  getClaudeModelOptions: (sessionId: string) =>
    ipcRenderer.invoke('claude:model-options', sessionId) as Promise<ClaudeModelOptions>,
  switchClaudeModel: (sessionId: string, optionId: string) =>
    ipcRenderer.invoke(
      'claude:switch-model',
      sessionId,
      optionId,
    ) as Promise<ClaudeOperationResult>,
  relaunchClaudeSession: (sessionId: string, input: ClaudeRelaunchInput) =>
    ipcRenderer.invoke('claude:relaunch', sessionId, input) as Promise<ClaudeOperationResult>,
  setClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) =>
    ipcRenderer.invoke(
      'claude:set-permission-mode',
      sessionId,
      mode,
    ) as Promise<ClaudeOperationResult>,
  setClaudeEffortLevel: (sessionId: string, effort: ClaudeEffortRequest) =>
    ipcRenderer.invoke('claude:set-effort', sessionId, effort) as Promise<ClaudeOperationResult>,
  observeClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => {
    ipcRenderer.send('claude:permission-mode-observed', sessionId, mode);
  },
  reportClaudePermissionModeProbe: (
    sessionId: string,
    probeId: number,
    mode?: ClaudePermissionMode,
  ) => {
    ipcRenderer.send('claude:permission-mode-probe-result', sessionId, probeId, mode);
  },
  onClaudePermissionModeProbe: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      probeId: unknown,
    ): void => {
      if (
        typeof sessionId === 'string' &&
        typeof probeId === 'number' &&
        Number.isSafeInteger(probeId)
      ) {
        listener(sessionId, probeId);
      }
    };
    ipcRenderer.on('claude:permission-mode-probe', callback);
    return () => {
      ipcRenderer.removeListener('claude:permission-mode-probe', callback);
    };
  },
  setClaudeAllowBypassPermissions: (sessionId: string, allowed: boolean) =>
    ipcRenderer.invoke(
      'claude:set-allow-bypass-permissions',
      sessionId,
      allowed,
    ) as Promise<ClaudeOperationResult>,
  applyClaudeConnectionHistory: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke(
      'claude:connection-history-apply',
      sessionId,
      entryId,
    ) as Promise<ClaudeConnectionHistoryResult>,
  deleteClaudeConnectionHistory: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke(
      'claude:connection-history-delete',
      sessionId,
      entryId,
    ) as Promise<ClaudeConnectionHistoryResult>,
  renameClaudeConnectionHistory: (sessionId: string, entryId: string, name: string) =>
    ipcRenderer.invoke(
      'claude:connection-history-rename',
      sessionId,
      entryId,
      name,
    ) as Promise<ClaudeConnectionHistoryResult>,
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  getWorkspace: () => ipcRenderer.invoke('workspace:get-state') as Promise<WorkspaceState>,
  getDevelopmentRuntime: (sessionId) => ipcRenderer.invoke('runtime:get', sessionId),
  setDevelopmentRuntime: (sessionId, runtime) =>
    ipcRenderer.invoke('runtime:set', sessionId, runtime),
  getCodexProjectState: (sessionId) =>
    ipcRenderer.invoke('codex:get-state', sessionId) as Promise<CodexProjectState>,
  installOrUpdateCodex: (sessionId) => ipcRenderer.invoke('codex:install-update', sessionId),
  startCodexLogin: (sessionId, method) =>
    ipcRenderer.invoke('codex:login-start', sessionId, method),
  cancelCodexLogin: (sessionId) => ipcRenderer.invoke('codex:login-cancel', sessionId),
  logoutCodex: (sessionId) => ipcRenderer.invoke('codex:logout', sessionId),
  launchCodex: (sessionId, mode) => ipcRenderer.invoke('codex:launch', sessionId, mode),
  onCodexState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: CodexProjectState): void => {
      listener(state);
    };
    ipcRenderer.on('codex:state', callback);
    return () => {
      ipcRenderer.removeListener('codex:state', callback);
    };
  },
  deleteClaudeRouterProvider: (sessionId, providerId) =>
    ipcRenderer.invoke(
      'claude:router-delete-provider',
      sessionId,
      providerId,
    ) as Promise<ClaudeRouterOperationResult>,
  installClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-install', sessionId) as Promise<ClaudeRouterOperationResult>,
  installClaudeRouterFromSource: (sessionId, source) =>
    ipcRenderer.invoke(
      'claude:router-install-source',
      sessionId,
      source,
    ) as Promise<ClaudeRouterOperationResult>,
  uninstallClaudeRouter: (sessionId) =>
    ipcRenderer.invoke(
      'claude:router-uninstall',
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  getRouterKernelState: (sessionId) =>
    ipcRenderer.invoke('router:kernel-state', sessionId) as Promise<RouterKernelState>,
  installCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      'router:cc-switch-install',
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  uninstallCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      'router:cc-switch-uninstall',
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  exportCurrentProviderToCcSwitch: (sessionId) =>
    ipcRenderer.invoke(
      'router:cc-switch-export-current',
      sessionId,
    ) as Promise<RouterKernelOperationResult>,
  launchClaude: (sessionId, mode) =>
    ipcRenderer.invoke('claude:launch', sessionId, mode) as Promise<ClaudeOperationResult>,
  confirmQuit: (confirmed) => {
    ipcRenderer.send('app:confirm-quit', confirmed);
  },
  minimizeToTray: () => {
    ipcRenderer.send('app:minimize-to-tray');
  },
  onOpenDownloadCenterRequested: (listener) => {
    const callback = (): void => {
      listener();
    };
    ipcRenderer.on('app:open-download-center', callback);
    return () => {
      ipcRenderer.removeListener('app:open-download-center', callback);
    };
  },
  onAppQuitRequested: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, request: AppQuitRequest): void => {
      ipcRenderer.send('app:quit-request-received');
      listener(request);
    };
    ipcRenderer.on('app:quit-requested', callback);
    return () => {
      ipcRenderer.removeListener('app:quit-requested', callback);
    };
  },
  onAppWindowRestored: (listener) => {
    const callback = (): void => {
      listener();
    };
    ipcRenderer.on('app:window-restored', callback);
    return () => {
      ipcRenderer.removeListener('app:window-restored', callback);
    };
  },
  onClaudeState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ClaudeProjectState): void => {
      listener(state);
    };
    ipcRenderer.on('claude:state', callback);
    return () => {
      ipcRenderer.removeListener('claude:state', callback);
    };
  },
  onTerminalData: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      data: unknown,
    ): void => {
      if (typeof sessionId === 'string' && typeof data === 'string') {
        listener(sessionId, data);
      }
    };
    ipcRenderer.on('terminal:data', callback);
    return () => {
      ipcRenderer.removeListener('terminal:data', callback);
    };
  },
  onTerminalSize: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      cols: unknown,
      rows: unknown,
    ): void => {
      if (typeof sessionId === 'string' && typeof cols === 'number' && typeof rows === 'number') {
        listener(sessionId, cols, rows);
      }
    };
    ipcRenderer.on('terminal:size', callback);
    return () => {
      ipcRenderer.removeListener('terminal:size', callback);
    };
  },
  onWorkspaceState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: WorkspaceState): void => {
      listener(state);
    };
    ipcRenderer.on('workspace:state', callback);
    return () => {
      ipcRenderer.removeListener('workspace:state', callback);
    };
  },
  resizeTerminal: (sessionId, cols, rows) => {
    ipcRenderer.send('terminal:resize', sessionId, cols, rows);
  },
  restartTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:restart', sessionId) as Promise<OperationResult>,
  runClaudeCommand: (sessionId, command, argument) =>
    ipcRenderer.invoke(
      'claude:command',
      sessionId,
      command,
      argument,
    ) as Promise<ClaudeOperationResult>,
  saveClaudeConfig: (sessionId, input) =>
    ipcRenderer.invoke('claude:save-config', sessionId, input) as Promise<ClaudeConfigResult>,
  saveClaudeRouterProvider: (sessionId, input) =>
    ipcRenderer.invoke(
      'claude:router-save-provider',
      sessionId,
      input,
    ) as Promise<ClaudeRouterOperationResult>,
  repairClaudeRouterFromProject: (sessionId) =>
    ipcRenderer.invoke(
      'claude:router-repair-from-project',
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  startClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-start', sessionId) as Promise<ClaudeRouterOperationResult>,
  stopClaudeRouter: (sessionId) =>
    ipcRenderer.invoke('claude:router-stop', sessionId) as Promise<ClaudeRouterOperationResult>,
  openClaudeRouterManagement: (sessionId) =>
    ipcRenderer.invoke(
      'claude:router-open-management',
      sessionId,
    ) as Promise<ClaudeRouterOperationResult>,
  testClaudeConnection: (sessionId, input) =>
    ipcRenderer.invoke(
      'claude:test-connection',
      sessionId,
      input,
    ) as Promise<ClaudeConnectionTestResult>,
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url) as Promise<boolean>,
  startTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:start', sessionId) as Promise<OperationResult>,
  stopTerminal: (sessionId) =>
    ipcRenderer.invoke('terminal:stop', sessionId) as Promise<OperationResult>,
  writeTerminal: (sessionId, data) => {
    ipcRenderer.send('terminal:write', sessionId, data);
  },
  getStoredProjects: () =>
    ipcRenderer.invoke('workspace:get-stored-projects') as Promise<WorkspaceProject[]>,
  removeStoredProject: (projectPath) =>
    ipcRenderer.invoke('workspace:remove-stored-project', projectPath) as Promise<void>,
  setAppTheme: (themeId) => ipcRenderer.invoke('ui:set-theme', themeId) as Promise<void>,
  getClaudeSessions: (sessionId) =>
    ipcRenderer.invoke('claude:get-sessions', sessionId) as Promise<ClaudeSessionMetadata[]>,
  getClaudeSessionsForPath: (projectPath) =>
    ipcRenderer.invoke('claude:get-sessions-for-path', projectPath) as Promise<
      ClaudeSessionMetadata[]
    >,
  renameClaudeSession: (projectPath, conversationId, title) =>
    ipcRenderer.invoke(
      'claude:rename-session',
      projectPath,
      conversationId,
      title,
    ) as Promise<boolean>,
  deleteClaudeSession: (projectPath, conversationId) =>
    ipcRenderer.invoke('claude:delete-session', projectPath, conversationId) as Promise<boolean>,
  launchClaudeWithSession: (sessionId, conversationId) =>
    ipcRenderer.invoke(
      'claude:launch-with-session',
      sessionId,
      conversationId,
    ) as Promise<ClaudeOperationResult>,
  getClaudePlugins: (refresh) =>
    ipcRenderer.invoke('claude:plugins-get', refresh ?? false) as Promise<ClaudePluginCatalog>,
  installClaudePlugin: (pluginId) =>
    ipcRenderer.invoke('claude:plugins-install', pluginId) as Promise<ClaudePluginOperationResult>,
  uninstallClaudePlugin: (pluginId) =>
    ipcRenderer.invoke(
      'claude:plugins-uninstall',
      pluginId,
    ) as Promise<ClaudePluginOperationResult>,
  setClaudePluginEnabled: (pluginId, enabled) =>
    ipcRenderer.invoke(
      'claude:plugins-set-enabled',
      pluginId,
      enabled,
    ) as Promise<ClaudePluginOperationResult>,
  updateClaudePlugin: (pluginId) =>
    ipcRenderer.invoke('claude:plugins-update', pluginId) as Promise<ClaudePluginOperationResult>,
  addClaudePluginMarketplace: (source) =>
    ipcRenderer.invoke(
      'claude:plugins-marketplace-add',
      source,
    ) as Promise<ClaudePluginOperationResult>,
  removeClaudePluginMarketplace: (name) =>
    ipcRenderer.invoke(
      'claude:plugins-marketplace-remove',
      name,
    ) as Promise<ClaudePluginOperationResult>,
  refreshClaudePluginMarketplaces: () =>
    ipcRenderer.invoke(
      'claude:plugins-marketplaces-refresh',
    ) as Promise<ClaudePluginOperationResult>,
  updateAllClaudePlugins: () =>
    ipcRenderer.invoke('claude:plugins-update-all') as Promise<ClaudePluginOperationResult>,
  getMcpCatalog: (cwd, refresh) =>
    ipcRenderer.invoke('mcp:get-catalog', cwd, refresh ?? false) as Promise<McpCatalog>,
  installMcpServer: (input) =>
    ipcRenderer.invoke('mcp:install', input) as Promise<McpOperationResult>,
  removeMcpServer: (input) =>
    ipcRenderer.invoke('mcp:remove', input) as Promise<McpOperationResult>,
  previewMcpToggle: (cwd, name, enabled) =>
    ipcRenderer.invoke('mcp:toggle-preview', cwd, name, enabled) as Promise<McpTogglePreview>,
  applyMcpToggle: (previewId, cwd) =>
    ipcRenderer.invoke('mcp:toggle-apply', previewId, cwd) as Promise<McpOperationResult>,
  getMcpBackups: () => ipcRenderer.invoke('mcp:backups') as Promise<McpBackupView[]>,
  restoreMcpBackup: (backupId, cwd) =>
    ipcRenderer.invoke('mcp:backup-restore', backupId, cwd) as Promise<McpOperationResult>,
  getSoftwareUpdates: (refresh) => ipcRenderer.invoke('software:updates-get', refresh ?? false),
  installOrUpdateClaudeCode: (source) =>
    ipcRenderer.invoke('software:claude-install-update', source),
  readClipboardText: () => ipcRenderer.invoke('app:clipboard-read') as Promise<string>,
  writeClipboardText: (text) => ipcRenderer.invoke('app:clipboard-write', text) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('controlPanel', api);
