import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ClaudeConfigResult,
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionHistoryResult,
  ClaudeConnectionTestResult,
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
  ClaudeSessionMetadata,
  ChatStreamEvent,
  ControlPanelApi,
  DirectoryChoiceResult,
  OperationResult,
  WorkspaceProject,
  WorkspaceResult,
  WorkspaceState,
} from '../shared/contracts';

const api: ControlPanelApi = {
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:set-launch-at-login', enabled),
  getChatConfig: () => ipcRenderer.invoke('chat:get-config'),
  saveChatConfig: (input) => ipcRenderer.invoke('chat:save-config', input),
  testChatConnection: (input) => ipcRenderer.invoke('chat:test-connection', input),
  getChatConversations: () => ipcRenderer.invoke('chat:list-conversations'),
  getChatConversation: (conversationId) =>
    ipcRenderer.invoke('chat:get-conversation', conversationId),
  saveChatConversation: (input) => ipcRenderer.invoke('chat:save-conversation', input),
  deleteChatConversation: (conversationId) =>
    ipcRenderer.invoke('chat:delete-conversation', conversationId),
  startChat: (input) => ipcRenderer.invoke('chat:start', input) as Promise<void>,
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
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  getWorkspace: () => ipcRenderer.invoke('workspace:get-state') as Promise<WorkspaceState>,
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
  launchClaude: (sessionId, mode) =>
    ipcRenderer.invoke('claude:launch', sessionId, mode) as Promise<ClaudeOperationResult>,
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
  getSoftwareUpdates: (refresh) => ipcRenderer.invoke('software:updates-get', refresh ?? false),
  installOrUpdateClaudeCode: (source) =>
    ipcRenderer.invoke('software:claude-install-update', source),
  readClipboardText: () => ipcRenderer.invoke('app:clipboard-read') as Promise<string>,
  writeClipboardText: (text) => ipcRenderer.invoke('app:clipboard-write', text) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('controlPanel', api);
