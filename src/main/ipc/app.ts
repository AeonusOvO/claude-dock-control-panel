import { CHANNELS } from '../../shared/ipc/channels';
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import type {
  AdvancedSettings,
  AppQuitDecisionResponse,
  AppSettingsView,
  ClaudeContextWindowMode,
  CloseBehavior,
  DiagnosticLogLevel,
  DiagnosticsQuery,
  DirectoryChoiceResult,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from '../../shared/contracts';
import { MAX_CLIPBOARD_TEXT_LENGTH } from '../../shared/contracts/terminal';
import {
  DEFAULT_TERMINAL_THEME,
  isTerminalThemeId,
  type TerminalThemeId,
} from '../../shared/ui/terminal-themes';
import type { ArtifactService } from '../artifact/service';
import type { StartupModelConnectionCoordinator } from '../app/startup-model-connection-coordinator';
import { isValidClaudeCustomContextWindow } from '../claude/configuration';
import type { Registry } from '../infra/registry';
import { CLAUDE_RUNTIME, MAIN_DIAGNOSTICS, MAIN_WINDOW } from '../infra/service-tokens';
import type { AdvancedSettingsStore } from '../stores/advanced-settings';
import {
  normalizeStartupModelConnectionMinutes,
  STARTUP_MODEL_CONNECT_CANCEL_MINUTES,
  STARTUP_MODEL_CONNECT_FORCE_STOP_MINUTES,
  type AppPreferencesStore,
} from '../stores/app-preferences';
import type { WorkspaceStore } from '../stores/workspace';
import type { TerminalWorkspace } from '../terminal/workspace';
import { validateExternalUrl, validateMarkdownExternalUrl, windowsBuildNumber } from './validation';
import type { MainState } from './context';
import type { MainGuards } from './guards';

const diagnosticLevels = new Set<DiagnosticLogLevel>(['debug', 'info', 'warn', 'error']);

const parseDiagnosticsQuery = (input: unknown): DiagnosticsQuery => {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('诊断查询参数无效。');
  }
  const candidate = input as Record<string, unknown>;
  const optionalText = (key: 'code' | 'domain' | 'message' | 'sessionId', limit: number) => {
    const value = candidate[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
      throw new Error('诊断查询参数无效。');
    }
    return value;
  };
  const level = candidate.level;
  if (
    level !== undefined &&
    (typeof level !== 'string' || !diagnosticLevels.has(level as DiagnosticLogLevel))
  ) {
    throw new Error('诊断查询级别无效。');
  }
  const limit = candidate.limit;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
  ) {
    throw new Error('诊断查询数量无效。');
  }
  return {
    code: optionalText('code', 100),
    domain: optionalText('domain', 100),
    level: level as DiagnosticLogLevel | undefined,
    limit: limit as number | undefined,
    message: optionalText('message', 2_000),
    sessionId: optionalText('sessionId', 200),
  };
};

const parseQuitDecisionResponse = (input: unknown): AppQuitDecisionResponse | undefined => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const candidate = input as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0 ||
    candidate.requestId.length > 100 ||
    (candidate.decision !== true &&
      candidate.decision !== false &&
      candidate.decision !== 'minimize' &&
      candidate.decision !== 'retry')
  ) {
    return undefined;
  }
  return {
    decision: candidate.decision,
    requestId: candidate.requestId,
  };
};

export interface AppIpcDependencies {
  advancedSettingsStore: AdvancedSettingsStore;
  appPreferencesStore: AppPreferencesStore;
  /* The window is created before any renderer exists, so the frame theme stays with the assembly. */
  applyWindowTheme: (themeId: TerminalThemeId) => void;
  artifactService: ArtifactService;
  /* Quit and tray flow through the window/tray assembly, which owns the single-instance handshake. */
  beginControlledQuit: (forceWithResidualProcesses: boolean) => Promise<void>;
  /* The tray "add project" entry opens the same dialog. */
  chooseDirectory: (ownerWindow?: BrowserWindow) => Promise<DirectoryChoiceResult>;
  guards: Pick<MainGuards, 'validateSender'>;
  hideMainWindowToTray: () => void;
  services: Registry;
  startupModelConnectionCoordinator: StartupModelConnectionCoordinator;
  state: MainState;
  workspace: TerminalWorkspace;
  workspaceStore: WorkspaceStore;
}

const registerQuitIpc = ({
  beginControlledQuit,
  guards: { validateSender },
  hideMainWindowToTray,
  state,
}: Pick<
  AppIpcDependencies,
  'beginControlledQuit' | 'guards' | 'hideMainWindowToTray' | 'state'
>): void => {
  ipcMain.on(CHANNELS.APP_CONFIRM_QUIT, (event, input: unknown) => {
    validateSender(event);
    const response = parseQuitDecisionResponse(input);
    const confirmation = state.quitConfirmation;
    if (
      !response ||
      !confirmation ||
      confirmation.owner !== 'renderer' ||
      confirmation.id !== response.requestId ||
      (confirmation.mode === 'ordinary' && response.decision === 'retry') ||
      (confirmation.mode === 'residual' &&
        (response.decision === false || response.decision === 'minimize'))
    ) {
      return;
    }
    if (state.quitConfirmationTimer) {
      clearTimeout(state.quitConfirmationTimer);
      state.quitConfirmationTimer = undefined;
    }
    state.quitConfirmation = undefined;
    if (response.decision === 'retry') {
      void beginControlledQuit(false);
      return;
    }
    if (response.decision === 'minimize') {
      hideMainWindowToTray();
      return;
    }
    if (response.decision === true) {
      void beginControlledQuit(confirmation.mode === 'residual');
    }
  });
  ipcMain.on(CHANNELS.APP_QUIT_REQUEST_RECEIVED, (event, requestId: unknown) => {
    validateSender(event);
    const confirmation = state.quitConfirmation;
    if (
      typeof requestId !== 'string' ||
      confirmation?.owner !== 'renderer' ||
      confirmation.id !== requestId
    ) {
      return;
    }
    if (state.quitConfirmationTimer) {
      clearTimeout(state.quitConfirmationTimer);
      state.quitConfirmationTimer = undefined;
    }
  });
};

const registerConversationResumePreferencesIpc = (input: {
  appPreferencesStore: AppPreferencesStore;
  appSettingsView: () => AppSettingsView;
  validateSender: MainGuards['validateSender'];
}): void => {
  ipcMain.handle(CHANNELS.APP_SET_CONVERSATION_RESUME_PREFERENCES, (event, value: unknown) => {
    input.validateSender(event);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('对话恢复设置无效。');
    }
    const preferences = value as Record<string, unknown>;
    const cancelAfterMinutes = preferences.startupModelConnectCancelAfterMinutes;
    const forceStopAfterMinutes = preferences.startupModelConnectForceStopAfterMinutes;
    if (
      (preferences.modelMismatchBehavior !== 'ask' &&
        preferences.modelMismatchBehavior !== 'use-conversation' &&
        preferences.modelMismatchBehavior !== 'use-current') ||
      typeof preferences.autoLoadLastConversationOnStartup !== 'boolean' ||
      typeof preferences.autoLoadLastConversationModelOnStartup !== 'boolean' ||
      typeof cancelAfterMinutes !== 'number' ||
      !Number.isSafeInteger(cancelAfterMinutes) ||
      cancelAfterMinutes < STARTUP_MODEL_CONNECT_CANCEL_MINUTES.min ||
      cancelAfterMinutes > STARTUP_MODEL_CONNECT_CANCEL_MINUTES.max ||
      typeof forceStopAfterMinutes !== 'number' ||
      !Number.isSafeInteger(forceStopAfterMinutes) ||
      forceStopAfterMinutes < STARTUP_MODEL_CONNECT_FORCE_STOP_MINUTES.min ||
      forceStopAfterMinutes > STARTUP_MODEL_CONNECT_FORCE_STOP_MINUTES.max ||
      forceStopAfterMinutes <= cancelAfterMinutes
    ) {
      throw new Error('对话恢复设置无效。');
    }
    const timing = normalizeStartupModelConnectionMinutes({
      startupModelConnectCancelAfterMinutes: cancelAfterMinutes,
      startupModelConnectForceStopAfterMinutes: forceStopAfterMinutes,
    });
    input.appPreferencesStore.set({
      conversationResume: {
        autoLoadLastConversationModelOnStartup: preferences.autoLoadLastConversationModelOnStartup,
        autoLoadLastConversationOnStartup: preferences.autoLoadLastConversationOnStartup,
        modelMismatchBehavior: preferences.modelMismatchBehavior,
        startupModelConnectCancelAfterMinutes: timing.cancelAfterMinutes,
        startupModelConnectForceStopAfterMinutes: timing.forceStopAfterMinutes,
      },
    });
    return input.appSettingsView();
  });
};

const registerStartupModelConnectionIpc = ({
  services,
  startupModelConnectionCoordinator,
  validateSender,
}: {
  services: Registry;
  startupModelConnectionCoordinator: StartupModelConnectionCoordinator;
  validateSender: MainGuards['validateSender'];
}): void => {
  ipcMain.handle(CHANNELS.APP_GET_STARTUP_MODEL_CONNECTION, (event) => {
    validateSender(event);
    return startupModelConnectionCoordinator.getState();
  });
  ipcMain.handle(CHANNELS.APP_CANCEL_STARTUP_MODEL_CONNECTION, async (event) => {
    validateSender(event);
    return startupModelConnectionCoordinator.cancel('user');
  });
  startupModelConnectionCoordinator.onChanged((connectionState) => {
    services
      .resolve(MAIN_WINDOW)
      .current?.webContents.send(CHANNELS.APP_STARTUP_MODEL_CONNECTION_CHANGED, connectionState);
  });
};

export const registerAppIpc = ({
  advancedSettingsStore,
  appPreferencesStore,
  applyWindowTheme,
  artifactService,
  beginControlledQuit,
  chooseDirectory,
  guards: { validateSender },
  hideMainWindowToTray,
  services,
  startupModelConnectionCoordinator,
  state,
  workspace,
  workspaceStore,
}: AppIpcDependencies): void => {
  const appSettingsView = (): AppSettingsView => ({
    advanced: advancedSettingsStore.get(),
    artifactNetworkAllowed: artifactService.getState().allowed,
    claudeContextWindowCustomTokens: appPreferencesStore.get().claudeContextWindowCustomTokens,
    claudeContextWindowMode: appPreferencesStore.get().claudeContextWindowMode,
    closeBehavior: appPreferencesStore.get().closeBehavior,
    conversationResume: { ...appPreferencesStore.get().conversationResume },
    footerResourcePreference: appPreferencesStore.get().footerResourcePreference,
    managedChatGptContextWindowMode: appPreferencesStore.get().managedChatGptContextWindowMode,
    language: 'zh-CN',
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    theme: workspaceStore.getTheme() ?? DEFAULT_TERMINAL_THEME,
    version: app.getVersion(),
    windowsBuildNumber: windowsBuildNumber(),
  });
  ipcMain.handle(CHANNELS.APP_GET_SETTINGS, (event) => {
    validateSender(event);
    return appSettingsView();
  });
  registerStartupModelConnectionIpc({
    services,
    startupModelConnectionCoordinator,
    validateSender,
  });
  ipcMain.handle(CHANNELS.APP_GET_DIAGNOSTICS, (event, query: unknown) => {
    validateSender(event);
    return services.resolve(MAIN_DIAGNOSTICS).query(parseDiagnosticsQuery(query));
  });
  ipcMain.handle(CHANNELS.APP_SET_ADVANCED_SETTINGS, (event, settings: unknown) => {
    validateSender(event);
    const record =
      settings && typeof settings === 'object'
        ? (settings as Partial<AdvancedSettings>)
        : undefined;
    if (
      ![0, 5, 10, 30].includes(record?.chatIdleTimeoutMinutes ?? -1) ||
      (record?.confirmFileDrops !== undefined && typeof record.confirmFileDrops !== 'boolean') ||
      !record?.networkPreflight ||
      typeof record.networkPreflight.checkOnNewSession !== 'boolean' ||
      typeof record.networkPreflight.checkOnProviderLogin !== 'boolean' ||
      (record.networkPreflight.cliTimezone !== undefined &&
        typeof record.networkPreflight.cliTimezone !== 'string') ||
      (record.networkPreflight.cliLanguages !== undefined &&
        (!Array.isArray(record.networkPreflight.cliLanguages) ||
          !record.networkPreflight.cliLanguages.every((item) => typeof item === 'string'))) ||
      typeof record?.webResearchIsolation !== 'boolean'
    ) {
      throw new Error('高级设置无效。');
    }
    advancedSettingsStore.set({
      chatIdleTimeoutMinutes: record.chatIdleTimeoutMinutes as 0 | 5 | 10 | 30,
      confirmFileDrops: record.confirmFileDrops ?? true,
      networkPreflight: {
        checkOnNewSession: record.networkPreflight.checkOnNewSession,
        checkOnProviderLogin: record.networkPreflight.checkOnProviderLogin,
        ...(record.networkPreflight.cliTimezone
          ? { cliTimezone: record.networkPreflight.cliTimezone }
          : {}),
        ...(record.networkPreflight.cliLanguages
          ? { cliLanguages: [...record.networkPreflight.cliLanguages] }
          : {}),
      },
      webResearchIsolation: record.webResearchIsolation,
    });
    return appSettingsView();
  });
  ipcMain.handle(CHANNELS.APP_SET_FOOTER_RESOURCE_PREFERENCE, (event, preference: unknown) => {
    validateSender(event);
    if (preference !== 'auto' && preference !== 'context' && preference !== 'quota') {
      throw new Error('底栏资源偏好无效。');
    }
    appPreferencesStore.set({ footerResourcePreference: preference as FooterResourcePreference });
    return appSettingsView();
  });
  ipcMain.handle(CHANNELS.APP_SET_MANAGED_CHATGPT_CONTEXT_WINDOW_MODE, (event, mode: unknown) => {
    validateSender(event);
    if (mode !== 'standard' && mode !== 'extended') {
      throw new Error('ChatGPT 上下文窗口模式无效。');
    }
    appPreferencesStore.set({
      managedChatGptContextWindowMode: mode as ManagedChatGptContextWindowMode,
    });
    return appSettingsView();
  });
  ipcMain.handle(
    CHANNELS.APP_SET_CLAUDE_CONTEXT_WINDOW_MODE,
    (event, mode: unknown, customTokens: unknown) => {
      validateSender(event);
      if (mode !== 'auto' && mode !== 'custom' && mode !== 'extended' && mode !== 'standard') {
        throw new Error('Claude 上下文窗口模式无效。');
      }
      const tokens = customTokens === undefined ? undefined : Number(customTokens);
      if (mode === 'custom' && !isValidClaudeCustomContextWindow(tokens)) {
        throw new Error('自定义上下文窗口需为 8000 到 2000000 之间的整数。');
      }
      appPreferencesStore.set({
        claudeContextWindowCustomTokens: mode === 'custom' ? tokens : undefined,
        claudeContextWindowMode: mode as ClaudeContextWindowMode,
      });
      return appSettingsView();
    },
  );
  ipcMain.handle(CHANNELS.APP_SET_LAUNCH_AT_LOGIN, (event, enabled: unknown) => {
    validateSender(event);
    if (typeof enabled !== 'boolean') {
      throw new Error('开机启动设置无效。');
    }
    app.setLoginItemSettings({
      args: app.isPackaged ? [] : [app.getAppPath()],
      openAtLogin: enabled,
      path: process.execPath,
    });
    return appSettingsView();
  });
  ipcMain.handle(CHANNELS.APP_SET_CLOSE_BEHAVIOR, (event, behavior: unknown) => {
    validateSender(event);
    if (behavior !== 'exit' && behavior !== 'tray') {
      throw new Error('关闭按钮行为无效。');
    }
    appPreferencesStore.set({ closeBehavior: behavior as CloseBehavior });
    return appSettingsView();
  });
  registerConversationResumePreferencesIpc({
    appPreferencesStore,
    appSettingsView,
    validateSender,
  });
  ipcMain.handle(CHANNELS.APP_OPEN_EXTERNAL, async (event, url: unknown) => {
    validateSender(event);
    try {
      await shell.openExternal(validateExternalUrl(url));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(CHANNELS.APP_CLIPBOARD_READ, (event) => {
    validateSender(event);
    return clipboard.readText().slice(0, MAX_CLIPBOARD_TEXT_LENGTH);
  });
  ipcMain.handle(CHANNELS.APP_CLIPBOARD_WRITE, (event, text: unknown) => {
    validateSender(event);
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
      return false;
    }
    clipboard.writeText(text);
    return true;
  });
  registerQuitIpc({
    beginControlledQuit,
    guards: { validateSender },
    hideMainWindowToTray,
    state,
  });
  ipcMain.on(CHANNELS.APP_MINIMIZE_TO_TRAY, (event) => {
    validateSender(event);
    hideMainWindowToTray();
  });
  ipcMain.handle(CHANNELS.MARKDOWN_OPEN_EXTERNAL, async (event, url: unknown) => {
    validateSender(event);
    try {
      await shell.openExternal(validateMarkdownExternalUrl(url));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(CHANNELS.DIRECTORY_CHOOSE, async (event) => {
    validateSender(event);
    return chooseDirectory(BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });
  ipcMain.handle(CHANNELS.UI_SET_THEME, async (event, themeId: unknown) => {
    validateSender(event);
    if (!isTerminalThemeId(themeId)) {
      throw new Error('主题标识无效。');
    }
    workspaceStore.setTheme(themeId);
    workspace.setTheme(themeId);
    services.resolve(CLAUDE_RUNTIME).setTheme(themeId);
    applyWindowTheme(themeId);
  });
};
