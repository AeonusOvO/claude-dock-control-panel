import type {
  ConversationControlUpdate,
  ConversationInteractionResponse,
  ConversationSnapshot,
  ConversationSubmitInput,
  NativeAttachmentBytesInput,
  NativeAttachmentImportResult,
  NativeAttachmentView,
  NativeConversationAdoptResult,
  NativeConversationDraftResult,
  NativeConversationLaunchRequest,
  NativeConversationOperationResult,
  NativeConversationStartResult,
  NativeConversationTerminalTransferResult,
  NativeRecoveryView,
} from '../conversation/native';
import type { TerminalThemeId } from '../ui/terminal-themes';
import type {
  AdvancedSettings,
  AppQuitDecisionResponse,
  AppQuitRequest,
  AppSettingsView,
  BusyLease,
  ClaudeContextWindowMode,
  CloseBehavior,
  FooterResourcePreference,
  ManagedChatGptContextWindowMode,
} from './app';
import type {
  ArtifactCreateResult,
  ArtifactNetworkLogEntry,
  ArtifactNetworkState,
} from './artifact';
import type {
  ChatAttachmentBytesImportInput,
  ChatAttachmentImportInput,
  ChatAttachmentImportResult,
  ChatAttachmentView,
  ChatConfigView,
  ChatConnectionTestResult,
  ChatConversation,
  ChatConversationSummary,
  ChatPreflightResult,
  ChatStartInput,
  ChatStreamEvent,
  SaveChatConfigInput,
  SaveChatConversationInput,
} from './chat';
import type {
  ClaudeConfigResult,
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionHistoryResult,
  ClaudeConnectionTestResult,
  ClaudeEffortRequest,
  ClaudeGatewayDiagnostics,
  ClaudeLaunchMode,
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionInput,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeModelOptions,
  ClaudeOperationResult,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudePermissionRequestView,
  ClaudeProjectState,
  ClaudeProviderModelDiscoveryInput,
  ClaudeProviderModelDiscoveryResult,
  ClaudeRelaunchInput,
  ClaudeSessionDeleteResult,
  ClaudeSessionMetadata,
  ModelSpeedMode,
  SaveClaudeConfigInput,
} from './claude';
import type {
  ClaudeExecutionSettingsDto,
  ClaudeExecutionSettingsRequest,
} from './claude-execution-settings';
import type { ClaudePluginCatalog, ClaudePluginOperationResult } from './claude-plugin';
import type {
  CodexLaunchMode,
  CodexLoginMethod,
  CodexLoginStartResult,
  CodexOperationResult,
  CodexProjectState,
} from './codex';
import type { DiagnosticsQuery, DiagnosticsView } from './diagnostics';
import type { DownloadTaskView } from './download';
import type {
  ManagedChatGptGatewayOperationResult,
  ManagedChatGptGatewayState,
  ManagedChatGptSetupProgress,
} from './managed-chatgpt';
import type {
  McpBackupView,
  McpCatalog,
  McpInstallInput,
  McpOperationResult,
  McpRemoveInput,
  McpTogglePreview,
} from './mcp';
import type {
  NetworkPreflightHistoryView,
  NetworkPreflightResult,
  NetworkPreflightRunInput,
  NetworkProviderId,
} from './network';
import type {
  ApplicationProxyCandidate,
  ApplicationProxyState,
  SaveApplicationProxyInput,
} from './proxy';
import type {
  ClaudeRouterInstallSource,
  ClaudeRouterManagementState,
  ClaudeRouterOperationResult,
  RouterKernelOperationResult,
  RouterKernelState,
  RouterOperationProgress,
  SaveClaudeRouterProviderInput,
} from './router';
import type { RuntimeActivitySnapshot } from './runtime';
import type {
  ApplicationUpdaterState,
  SoftwareUpdateOperationResult,
  SoftwareUpdateState,
} from './software';
import type { OperationResult, PtyGeneration } from './terminal';
import type {
  DevelopmentRuntime,
  DevelopmentRuntimeState,
  DirectoryChoiceResult,
  WorkspaceProject,
  WorkspaceResult,
  WorkspaceState,
} from './workspace';

export type Unsubscribe = () => void;

export interface AppApi {
  getAppSettings: () => Promise<AppSettingsView>;
  getDiagnostics: (query?: DiagnosticsQuery) => Promise<DiagnosticsView>;
  setLaunchAtLogin: (enabled: boolean) => Promise<AppSettingsView>;
  setFooterResourcePreference: (preference: FooterResourcePreference) => Promise<AppSettingsView>;
  setManagedChatGptContextWindowMode: (
    mode: ManagedChatGptContextWindowMode,
  ) => Promise<AppSettingsView>;
  setClaudeContextWindowMode: (
    mode: ClaudeContextWindowMode,
    customTokens?: number,
  ) => Promise<AppSettingsView>;
  setAdvancedSettings: (settings: AdvancedSettings) => Promise<AppSettingsView>;
  setCloseBehavior: (behavior: CloseBehavior) => Promise<AppSettingsView>;
  openMarkdownExternal: (url: string) => Promise<boolean>;
  getDroppedPath: (file: File) => string;
  /**
   * The main process asks before it quits, so a streaming conversation or a busy terminal can be
   * protected by a themed dialog instead of dying silently. The renderer must answer every request
   * through `confirmQuit`, including the cancelling answer — the quit stays blocked until it does.
   */
  onAppQuitRequested: (listener: (request: AppQuitRequest) => void) => Unsubscribe;
  onAppQuitRequestInvalidated: (listener: (requestId: string) => void) => Unsubscribe;
  confirmQuit: (response: AppQuitDecisionResponse) => void;
  minimizeToTray: () => void;
  onOpenDownloadCenterRequested: (listener: () => void) => Unsubscribe;
  onAppWindowRestored: (listener: () => void) => Unsubscribe;
  openExternal: (url: string) => Promise<boolean>;
  /** Repaints the native frame and remembers the choice for the next cold start. */
  setAppTheme: (themeId: TerminalThemeId) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<boolean>;
}

export interface WorkspaceApi {
  activateProject: (sessionId: string) => Promise<WorkspaceResult>;
  addProject: (directoryPath: string) => Promise<WorkspaceResult>;
  chooseDirectory: () => Promise<DirectoryChoiceResult>;
  closeProject: (sessionId: string) => Promise<WorkspaceResult>;
  /** Close every live conversation of a folder but keep the folder remembered. */
  closeProjectFolder: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open one more concurrent conversation inside an already-open folder. */
  openConversation: (projectPath: string) => Promise<WorkspaceResult>;
  /** Open a remembered folder's history entry as a live conversation. */
  openStoredConversation: (projectPath: string, conversationId: string) => Promise<WorkspaceResult>;
  renameConversation: (sessionId: string, title: string) => Promise<WorkspaceResult>;
  /** Forget a folder entirely: closes its conversations and drops it from disk. */
  forgetProject: (projectPath: string) => Promise<WorkspaceResult>;
  getWorkspace: () => Promise<WorkspaceState>;
  getDevelopmentRuntime: (sessionId: string) => Promise<DevelopmentRuntimeState>;
  setDevelopmentRuntime: (
    sessionId: string,
    runtime: DevelopmentRuntime,
  ) => Promise<DevelopmentRuntimeState>;
  onWorkspaceState: (listener: (state: WorkspaceState) => void) => Unsubscribe;
  getStoredProjects: () => Promise<WorkspaceProject[]>;
  removeStoredProject: (projectPath: string) => Promise<void>;
}

export interface TerminalApi {
  onTerminalData: (
    listener: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void,
  ) => Unsubscribe;
  /** Application-normalized size echo; resizeRevision prevents an older echo winning a later fit. */
  onTerminalSize: (
    listener: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      resizeRevision: number,
      cols: number,
      rows: number,
    ) => void,
  ) => Unsubscribe;
  resizeTerminal: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    resizeRevision: number,
    cols: number,
    rows: number,
  ) => void;
  restartTerminal: (
    sessionId: string,
    expectedGeneration: PtyGeneration,
  ) => Promise<OperationResult>;
  startTerminal: (sessionId: string, expectedGeneration: PtyGeneration) => Promise<OperationResult>;
  stopTerminal: (sessionId: string, expectedGeneration: PtyGeneration) => Promise<OperationResult>;
  writeTerminal: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => void;
}

export interface BusyApi {
  listBusyLeases: () => Promise<BusyLease[]>;
  onBusyChanged: (listener: (leases: BusyLease[]) => void) => Unsubscribe;
  setConversationBusy: (busy: boolean) => Promise<BusyLease[]>;
}

export interface RuntimeApi {
  getRuntimeActivity: (sessionId: string) => Promise<RuntimeActivitySnapshot>;
  onRuntimeActivityChanged: (listener: (state: RuntimeActivitySnapshot) => void) => Unsubscribe;
  terminateRuntimeProcess: (
    sessionId: string,
    processKey: string,
  ) => Promise<RuntimeActivitySnapshot>;
}

export interface DownloadApi {
  cancelDownload: (taskId: string) => Promise<DownloadTaskView>;
  clearDownloadHistory: () => Promise<DownloadTaskView[]>;
  deleteDownloadHistory: (taskId: string) => Promise<DownloadTaskView[]>;
  listDownloads: () => Promise<DownloadTaskView[]>;
  onDownloadsChanged: (listener: (tasks: DownloadTaskView[]) => void) => Unsubscribe;
  pauseDownload: (taskId: string) => Promise<DownloadTaskView>;
  resumeDownload: (taskId: string) => Promise<DownloadTaskView>;
}

export interface ApplicationProxyApi {
  getApplicationProxyState: () => Promise<ApplicationProxyState>;
  saveApplicationProxy: (input: SaveApplicationProxyInput) => Promise<ApplicationProxyState>;
  testApplicationProxy: () => Promise<ApplicationProxyState>;
  detectApplicationProxyCandidates: () => Promise<ApplicationProxyCandidate[]>;
  onApplicationProxyChanged: (listener: (state: ApplicationProxyState) => void) => Unsubscribe;
}

export interface ArtifactApi {
  createArtifact: (html: string) => Promise<ArtifactCreateResult>;
  destroyArtifact: (artifactId: string) => Promise<boolean>;
  getArtifactNetworkState: () => Promise<ArtifactNetworkState>;
  setArtifactNetworkAllowed: (allowed: boolean) => Promise<ArtifactNetworkState>;
  onArtifactNetworkLog: (listener: (entry: ArtifactNetworkLogEntry) => void) => Unsubscribe;
}

export interface ChatApi {
  getChatConfig: () => Promise<ChatConfigView>;
  saveChatConfig: (input: SaveChatConfigInput) => Promise<ChatConfigView>;
  testChatConnection: (input: SaveChatConfigInput) => Promise<ChatConnectionTestResult>;
  importChatAttachments: (input: ChatAttachmentImportInput) => Promise<ChatAttachmentImportResult>;
  importChatAttachmentBytes: (
    input: ChatAttachmentBytesImportInput,
  ) => Promise<ChatAttachmentImportResult>;
  importChatClipboardImage: (draftId?: string) => Promise<ChatAttachmentImportResult>;
  readChatAttachment: (attachmentId: string) => Promise<ChatAttachmentView | undefined>;
  deleteChatDraftAttachment: (draftId: string, attachmentId: string) => Promise<boolean>;
  releaseChatAttachmentDraft: (draftId: string) => Promise<number>;
  getChatConversations: () => Promise<ChatConversationSummary[]>;
  getChatConversation: (conversationId: string) => Promise<ChatConversation | undefined>;
  saveChatConversation: (input: SaveChatConversationInput) => Promise<ChatConversation>;
  renameChatConversation: (
    conversationId: string,
    title: string,
  ) => Promise<ChatConversation | undefined>;
  deleteChatConversation: (conversationId: string) => Promise<boolean>;
  preflightChat: (input: ChatStartInput) => Promise<ChatPreflightResult>;
  startChat: (input: ChatStartInput) => Promise<ChatPreflightResult>;
  stopChat: (requestId: string) => Promise<void>;
  onChatStream: (listener: (event: ChatStreamEvent) => void) => Unsubscribe;
}

export interface NetworkPreflightApi {
  getNetworkPreflight: (provider: NetworkProviderId) => Promise<NetworkPreflightResult>;
  runNetworkPreflight: (input: NetworkPreflightRunInput) => Promise<NetworkPreflightResult>;
  invalidateNetworkPreflight: (reason: string) => Promise<void>;
  getNetworkPreflightHistory: () => Promise<NetworkPreflightHistoryView>;
  clearNetworkPreflightHistory: () => Promise<NetworkPreflightHistoryView>;
  onNetworkPreflight: (listener: (result: NetworkPreflightResult) => void) => Unsubscribe;
}

export interface NativeConversationApi {
  startNativeConversation: (
    input: NativeConversationLaunchRequest,
  ) => Promise<NativeConversationStartResult>;
  getNativeConversation: (conversationId: string) => Promise<ConversationSnapshot | undefined>;
  submitNativeConversation: (
    conversationId: string,
    input: ConversationSubmitInput,
  ) => Promise<NativeConversationOperationResult>;
  respondNativeConversation: (
    conversationId: string,
    interactionId: string,
    response: ConversationInteractionResponse,
  ) => Promise<NativeConversationOperationResult>;
  interruptNativeConversation: (
    conversationId: string,
  ) => Promise<NativeConversationOperationResult>;
  stopNativeConversationTask: (
    conversationId: string,
    taskId: string,
  ) => Promise<NativeConversationOperationResult>;
  updateNativeConversationControls: (
    conversationId: string,
    update: ConversationControlUpdate,
  ) => Promise<NativeConversationOperationResult>;
  closeNativeConversation: (conversationId: string) => Promise<NativeConversationOperationResult>;
  renameNativeConversation: (conversationId: string, title: string) => Promise<boolean>;
  transferNativeConversationToTerminal: (
    conversationId: string,
    draft?: ConversationSubmitInput,
    allowInterrupt?: boolean,
  ) => Promise<NativeConversationTerminalTransferResult>;
  adoptTerminalConversation: (
    sessionId: string,
    allowInterrupt?: boolean,
  ) => Promise<NativeConversationAdoptResult>;
  listNativeRecoveries: () => Promise<NativeRecoveryView[]>;
  restoreNativeDraft: (
    conversationId: string,
    clientSubmissionId: string,
    projectPath: string,
  ) => Promise<NativeConversationDraftResult>;
  discardNativeRecovery: (conversationId: string, projectPath: string) => Promise<boolean>;
  onNativeConversation: (listener: (snapshot: ConversationSnapshot) => void) => Unsubscribe;
  onConversationOwnerConflict: (
    listener: (conflict: {
      conversationId: string;
      existingOwnerKind: 'native' | 'terminal';
      existingSessionId?: string;
      sessionId: string;
    }) => void,
  ) => Unsubscribe;
}

export interface NativeAttachmentApi {
  importNativeAttachmentPaths: (
    conversationId: string,
    paths: string[],
  ) => Promise<NativeAttachmentImportResult>;
  importNativeAttachmentBytes: (
    conversationId: string,
    sources: NativeAttachmentBytesInput[],
  ) => Promise<NativeAttachmentImportResult>;
  importNativeClipboardImage: (conversationId: string) => Promise<NativeAttachmentImportResult>;
  readNativeAttachment: (
    conversationId: string,
    attachmentId: string,
  ) => Promise<NativeAttachmentView | undefined>;
  removeNativeAttachment: (conversationId: string, attachmentId: string) => Promise<boolean>;
}

export interface ClaudeApi {
  onClaudePermissionRequest: (
    listener: (request: ClaudePermissionRequestView) => void,
  ) => Unsubscribe;
  respondClaudePermission: (
    requestId: string,
    decision: ClaudePermissionDecision,
  ) => Promise<boolean>;
  getClaudeProjectState: (sessionId: string) => Promise<ClaudeProjectState>;
  getClaudeGatewayDiagnostics: (sessionId: string) => Promise<ClaudeGatewayDiagnostics>;
  getClaudeRouterManagementState: (sessionId: string) => Promise<ClaudeRouterManagementState>;
  getClaudeConnectionAdvice: (sessionId: string) => Promise<ClaudeConnectionAdvice>;
  getClaudeConnectionHistory: (sessionId: string) => Promise<ClaudeConnectionHistoryEntry[]>;
  getClaudeModelOptions: (sessionId: string) => Promise<ClaudeModelOptions>;
  /** Switches inside the live conversation with `/model`; only valid for same-endpoint options. */
  switchClaudeModel: (sessionId: string, optionId: string) => Promise<ClaudeOperationResult>;
  /**
   * Relaunches the PTY so a new base URL, credential or permission mode takes effect, then
   * reattaches the same conversation with `--continue`.
   */
  relaunchClaudeSession: (
    sessionId: string,
    input: ClaudeRelaunchInput,
  ) => Promise<ClaudeLaunchOutcome>;
  decideClaudeLaunchPreflight: (
    input: ClaudeLaunchPreflightDecisionInput,
  ) => Promise<ClaudeLaunchPreflightDecisionOutcome>;
  /** Walks the Shift+Tab cycle until the live badge reports the requested mode. */
  setClaudePermissionMode: (
    sessionId: string,
    mode: ClaudePermissionMode,
  ) => Promise<ClaudeOperationResult>;
  /** Applies a reasoning effort level to the live conversation with `/effort`. */
  setClaudeEffortLevel: (
    sessionId: string,
    effort: ClaudeEffortRequest,
  ) => Promise<ClaudeOperationResult>;
  /** Persists a per-model serving-speed preference and relaunches the exact live conversation if needed. */
  setClaudeModelSpeed: (sessionId: string, mode: ModelSpeedMode) => Promise<ClaudeOperationResult>;
  /** Reports the complete mode badge after xterm has applied PTY screen-delta output. */
  observeClaudePermissionMode: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    mode: ClaudePermissionMode,
  ) => void;
  /** Answers a main-process probe with the mode currently visible in xterm's complete screen. */
  reportClaudePermissionModeProbe: (
    sessionId: string,
    ptyGeneration: PtyGeneration,
    probeId: number,
    mode?: ClaudePermissionMode,
  ) => void;
  /** Receives an on-demand request to read the current xterm screen, even if no new PTY data arrived. */
  onClaudePermissionModeProbe: (
    listener: (sessionId: string, ptyGeneration: PtyGeneration, probeId: number) => void,
  ) => Unsubscribe;
  setClaudeAllowBypassPermissions: (
    sessionId: string,
    allowed: boolean,
  ) => Promise<ClaudeOperationResult>;
  applyClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  deleteClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  renameClaudeConnectionHistory: (
    sessionId: string,
    entryId: string,
    name: string,
  ) => Promise<ClaudeConnectionHistoryResult>;
  discoverClaudeProviderModels: (
    sessionId: string,
    input: ClaudeProviderModelDiscoveryInput,
  ) => Promise<ClaudeProviderModelDiscoveryResult>;
  launchClaude: (sessionId: string, mode: ClaudeLaunchMode) => Promise<ClaudeLaunchOutcome>;
  onClaudeState: (listener: (state: ClaudeProjectState) => void) => Unsubscribe;
  runClaudeCommand: (
    sessionId: string,
    command: string,
    argument?: string,
  ) => Promise<ClaudeOperationResult>;
  saveClaudeConfig: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConfigResult>;
  testClaudeConnection: (
    sessionId: string,
    input: SaveClaudeConfigInput,
  ) => Promise<ClaudeConnectionTestResult>;
  getClaudeSessions: (sessionId: string) => Promise<ClaudeSessionMetadata[]>;
  getClaudeSessionsForPath: (projectPath: string) => Promise<ClaudeSessionMetadata[]>;
  renameClaudeSession: (
    projectPath: string,
    conversationId: string,
    title: string,
  ) => Promise<boolean>;
  deleteClaudeSession: (
    projectPath: string,
    conversationId: string,
  ) => Promise<ClaudeSessionDeleteResult>;
  launchClaudeWithSession: (
    sessionId: string,
    conversationId: string,
  ) => Promise<ClaudeLaunchOutcome>;
}

export interface ClaudeExecutionSettingsApi {
  getClaudeExecutionSettings: () => Promise<ClaudeExecutionSettingsDto>;
  updateClaudeExecutionSettings: (
    requested: ClaudeExecutionSettingsRequest,
  ) => Promise<ClaudeExecutionSettingsDto>;
  useRecommendedClaudeExecutionSettings: () => Promise<ClaudeExecutionSettingsDto>;
  restoreClaudeExecutionSettingsDefault: () => Promise<ClaudeExecutionSettingsDto>;
}

export interface ClaudePluginApi {
  getClaudePlugins: (refresh?: boolean) => Promise<ClaudePluginCatalog>;
  installClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  uninstallClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  setClaudePluginEnabled: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<ClaudePluginOperationResult>;
  updateClaudePlugin: (pluginId: string) => Promise<ClaudePluginOperationResult>;
  addClaudePluginMarketplace: (source: string) => Promise<ClaudePluginOperationResult>;
  removeClaudePluginMarketplace: (name: string) => Promise<ClaudePluginOperationResult>;
  refreshClaudePluginMarketplaces: () => Promise<ClaudePluginOperationResult>;
  updateAllClaudePlugins: () => Promise<ClaudePluginOperationResult>;
}

export interface ManagedChatGptApi {
  getManagedChatGptGatewayState: () => Promise<ManagedChatGptGatewayState>;
  logoutManagedChatGptGateway: () => Promise<ManagedChatGptGatewayOperationResult>;
  openManagedChatGptGatewayManagement: () => Promise<OperationResult>;
  onManagedChatGptSetupProgress: (
    listener: (progress: ManagedChatGptSetupProgress) => void,
  ) => Unsubscribe;
  setManagedChatGptGatewayModel: (
    sessionId: string,
    model: string,
  ) => Promise<ManagedChatGptGatewayOperationResult>;
  setupManagedChatGptGateway: (sessionId?: string) => Promise<ManagedChatGptGatewayOperationResult>;
}

export interface RouterApi {
  deleteClaudeRouterProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  installClaudeRouterFromSource: (
    sessionId: string,
    source: ClaudeRouterInstallSource,
  ) => Promise<ClaudeRouterOperationResult>;
  uninstallClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  getRouterKernelState: (sessionId: string) => Promise<RouterKernelState>;
  onRouterOperationProgress: (listener: (progress: RouterOperationProgress) => void) => Unsubscribe;
  installCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  uninstallCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  exportCurrentProviderToCcSwitch: (sessionId: string) => Promise<RouterKernelOperationResult>;
  openClaudeRouterManagement: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  saveClaudeRouterProvider: (
    sessionId: string,
    input: SaveClaudeRouterProviderInput,
  ) => Promise<ClaudeRouterOperationResult>;
  repairClaudeRouterFromProject: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  startClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
  stopClaudeRouter: (sessionId: string) => Promise<ClaudeRouterOperationResult>;
}

export interface CodexApi {
  getCodexProjectState: (sessionId: string) => Promise<CodexProjectState>;
  installOrUpdateCodex: (sessionId: string) => Promise<CodexOperationResult>;
  startCodexLogin: (sessionId: string, method: CodexLoginMethod) => Promise<CodexLoginStartResult>;
  cancelCodexLogin: (sessionId: string) => Promise<CodexOperationResult>;
  logoutCodex: (sessionId: string) => Promise<CodexOperationResult>;
  launchCodex: (sessionId: string, mode: CodexLaunchMode) => Promise<CodexOperationResult>;
  onCodexState: (listener: (state: CodexProjectState) => void) => Unsubscribe;
}

export interface McpApi {
  getMcpCatalog: (cwd: string, refreshRegistry?: boolean) => Promise<McpCatalog>;
  installMcpServer: (input: McpInstallInput) => Promise<McpOperationResult>;
  removeMcpServer: (input: McpRemoveInput) => Promise<McpOperationResult>;
  previewMcpToggle: (cwd: string, name: string, enabled: boolean) => Promise<McpTogglePreview>;
  applyMcpToggle: (previewId: string, cwd: string) => Promise<McpOperationResult>;
  discardMcpToggle: (previewId: string) => Promise<boolean>;
  getMcpBackups: () => Promise<McpBackupView[]>;
  restoreMcpBackup: (backupId: string, cwd: string) => Promise<McpOperationResult>;
}

export interface SoftwareUpdateApi {
  getSoftwareUpdates: (refresh?: boolean) => Promise<SoftwareUpdateState>;
  installOrUpdateClaudeCode: () => Promise<SoftwareUpdateOperationResult>;
  getApplicationUpdaterState: (refresh?: boolean) => Promise<ApplicationUpdaterState>;
  downloadApplicationUpdate: () => Promise<ApplicationUpdaterState>;
  installApplicationUpdate: () => Promise<void>;
  onApplicationUpdaterChanged: (listener: (state: ApplicationUpdaterState) => void) => () => void;
}

/**
 * The whole preload bridge. Every method lives in one of the per-domain interfaces above; this
 * interface only composes them, so `window.controlPanel` stays one flat object at runtime.
 */
export interface ControlPanelApi
  extends
    AppApi,
    WorkspaceApi,
    TerminalApi,
    BusyApi,
    RuntimeApi,
    DownloadApi,
    ApplicationProxyApi,
    ArtifactApi,
    ChatApi,
    NetworkPreflightApi,
    NativeConversationApi,
    NativeAttachmentApi,
    ClaudeApi,
    ClaudeExecutionSettingsApi,
    ClaudePluginApi,
    ManagedChatGptApi,
    RouterApi,
    CodexApi,
    McpApi,
    SoftwareUpdateApi {}
