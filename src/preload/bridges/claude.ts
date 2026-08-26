import { ipcRenderer } from 'electron';
import type {
  ControlPanelApi,
  ClaudeConfigResult,
  ClaudeConnectionAdvice,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionHistoryResult,
  ClaudeConnectionTestResult,
  ClaudeConversationModelApplyResult,
  ClaudeConversationModelResolution,
  ClaudeEffortRequest,
  ClaudeGatewayDiagnostics,
  ClaudeLaunchOutcome,
  ClaudeLaunchPreflightDecisionInput,
  ClaudeLaunchPreflightDecisionOutcome,
  ClaudeModelOptions,
  ClaudeNextConversationConnectionResult,
  ClaudeNextConversationConnectionState,
  ClaudeOperationResult,
  ClaudePermissionMode,
  ClaudeProjectState,
  ClaudeRelaunchInput,
  ClaudeRouterManagementState,
  ClaudeSessionDeleteResult,
  ModelSpeedMode,
  ClaudeProviderModelDiscoveryResult,
  ClaudeSessionMetadata,
} from '../../shared/contracts';
import { CHANNELS } from '../../shared/ipc/channels';

export const claudeBridge = {
  onClaudePermissionRequest: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      request: Parameters<typeof listener>[0],
    ): void => {
      listener(request);
    };
    ipcRenderer.on(CHANNELS.CLAUDE_PERMISSION_REQUEST, callback);
    return () => ipcRenderer.removeListener(CHANNELS.CLAUDE_PERMISSION_REQUEST, callback);
  },
  respondClaudePermission: (requestId, decision) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_PERMISSION_RESPONSE, requestId, decision),
  getClaudeProjectState: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_GET_STATE, sessionId) as Promise<ClaudeProjectState>,
  getClaudeGatewayDiagnostics: (sessionId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_GET_GATEWAY_DIAGNOSTICS,
      sessionId,
    ) as Promise<ClaudeGatewayDiagnostics>,
  getClaudeRouterManagementState: (sessionId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_ROUTER_GET_STATE,
      sessionId,
    ) as Promise<ClaudeRouterManagementState>,
  getClaudeConnectionAdvice: (sessionId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_GET_CONNECTION_ADVICE,
      sessionId,
    ) as Promise<ClaudeConnectionAdvice>,
  getClaudeConnectionHistory: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_CONNECTION_HISTORY, sessionId) as Promise<
      ClaudeConnectionHistoryEntry[]
    >,
  getClaudeModelOptions: (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_MODEL_OPTIONS, sessionId) as Promise<ClaudeModelOptions>,
  switchClaudeModel: (sessionId: string, optionId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SWITCH_MODEL,
      sessionId,
      optionId,
    ) as Promise<ClaudeOperationResult>,
  relaunchClaudeSession: (sessionId: string, input: ClaudeRelaunchInput) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_RELAUNCH, sessionId, input) as Promise<ClaudeLaunchOutcome>,
  decideClaudeLaunchPreflight: (input: ClaudeLaunchPreflightDecisionInput) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_LAUNCH_PREFLIGHT_DECIDE,
      input,
    ) as Promise<ClaudeLaunchPreflightDecisionOutcome>,
  setClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SET_PERMISSION_MODE,
      sessionId,
      mode,
    ) as Promise<ClaudeOperationResult>,
  setClaudeEffortLevel: (sessionId: string, effort: ClaudeEffortRequest) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SET_EFFORT,
      sessionId,
      effort,
    ) as Promise<ClaudeOperationResult>,
  setClaudeModelSpeed: (sessionId: string, mode: ModelSpeedMode) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SET_MODEL_SPEED,
      sessionId,
      mode,
    ) as Promise<ClaudeOperationResult>,
  observeClaudePermissionMode: (sessionId, ptyGeneration, mode) => {
    ipcRenderer.send(CHANNELS.CLAUDE_PERMISSION_MODE_OBSERVED, sessionId, ptyGeneration, mode);
  },
  reportClaudePermissionModeProbe: (sessionId, ptyGeneration, probeId, mode) => {
    ipcRenderer.send(
      CHANNELS.CLAUDE_PERMISSION_MODE_PROBE_RESULT,
      sessionId,
      ptyGeneration,
      probeId,
      mode,
    );
  },
  onClaudePermissionModeProbe: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      sessionId: unknown,
      ptyGeneration: unknown,
      probeId: unknown,
    ): void => {
      if (
        typeof sessionId === 'string' &&
        typeof ptyGeneration === 'number' &&
        Number.isSafeInteger(ptyGeneration) &&
        ptyGeneration >= 0 &&
        typeof probeId === 'number' &&
        Number.isSafeInteger(probeId)
      ) {
        listener(sessionId, ptyGeneration, probeId);
      }
    };
    ipcRenderer.on(CHANNELS.CLAUDE_PERMISSION_MODE_PROBE, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.CLAUDE_PERMISSION_MODE_PROBE, callback);
    };
  },
  setClaudeAllowBypassPermissions: (sessionId: string, allowed: boolean) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SET_ALLOW_BYPASS_PERMISSIONS,
      sessionId,
      allowed,
    ) as Promise<ClaudeOperationResult>,
  applyClaudeConnectionHistory: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONNECTION_HISTORY_APPLY,
      sessionId,
      entryId,
    ) as Promise<ClaudeConnectionHistoryResult>,
  cancelClaudeConnectionHistoryApply: (sessionId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONNECTION_HISTORY_CANCEL_APPLY,
      sessionId,
    ) as Promise<boolean>,
  deleteClaudeConnectionHistory: (sessionId: string, entryId: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONNECTION_HISTORY_DELETE,
      sessionId,
      entryId,
    ) as Promise<ClaudeConnectionHistoryResult>,
  renameClaudeConnectionHistory: (sessionId: string, entryId: string, name: string) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONNECTION_HISTORY_RENAME,
      sessionId,
      entryId,
      name,
    ) as Promise<ClaudeConnectionHistoryResult>,
  discoverClaudeProviderModels: (sessionId, input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_PROVIDER_MODELS_DISCOVER,
      sessionId,
      input,
    ) as Promise<ClaudeProviderModelDiscoveryResult>,
  launchClaude: (sessionId, mode) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_LAUNCH, sessionId, mode) as Promise<ClaudeLaunchOutcome>,
  getNextClaudeConnection: () =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_GET_NEXT_CONNECTION,
    ) as Promise<ClaudeNextConversationConnectionState>,
  onClaudeState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ClaudeProjectState): void => {
      listener(state);
    };
    ipcRenderer.on(CHANNELS.CLAUDE_STATE, callback);
    return () => {
      ipcRenderer.removeListener(CHANNELS.CLAUDE_STATE, callback);
    };
  },
  runClaudeCommand: (sessionId, command, argument) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_COMMAND,
      sessionId,
      command,
      argument,
    ) as Promise<ClaudeOperationResult>,
  saveClaudeConfig: (sessionId, input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SAVE_CONFIG,
      sessionId,
      input,
    ) as Promise<ClaudeConfigResult>,
  saveNextClaudeConfig: (input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_SAVE_NEXT_CONFIG,
      input,
    ) as Promise<ClaudeNextConversationConnectionResult>,
  testClaudeConnection: (sessionId, input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_TEST_CONNECTION,
      sessionId,
      input,
    ) as Promise<ClaudeConnectionTestResult>,
  testNextClaudeConnection: (input) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_TEST_NEXT_CONNECTION,
      input,
    ) as Promise<ClaudeConnectionTestResult>,
  getClaudeSessions: (sessionId) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_GET_SESSIONS, sessionId) as Promise<ClaudeSessionMetadata[]>,
  getClaudeSessionsForPath: (projectPath) =>
    ipcRenderer.invoke(CHANNELS.CLAUDE_GET_SESSIONS_FOR_PATH, projectPath) as Promise<
      ClaudeSessionMetadata[]
    >,
  inspectClaudeConversationModel: (projectPath, conversationId, legacyModelHint) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONVERSATION_MODEL_INSPECT,
      projectPath,
      conversationId,
      legacyModelHint,
    ) as Promise<ClaudeConversationModelResolution>,
  renameClaudeSession: (projectPath, conversationId, title) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_RENAME_SESSION,
      projectPath,
      conversationId,
      title,
    ) as Promise<boolean>,
  deleteClaudeSession: (projectPath, conversationId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_DELETE_SESSION,
      projectPath,
      conversationId,
    ) as Promise<ClaudeSessionDeleteResult>,
  launchClaudeWithSession: (sessionId, conversationId) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_LAUNCH_WITH_SESSION,
      sessionId,
      conversationId,
    ) as Promise<ClaudeLaunchOutcome>,
  applyClaudeConversationModel: (sessionId, conversationId, choice) =>
    ipcRenderer.invoke(
      CHANNELS.CLAUDE_CONVERSATION_MODEL_APPLY,
      sessionId,
      conversationId,
      choice,
    ) as Promise<ClaudeConversationModelApplyResult>,
} satisfies Partial<ControlPanelApi>;
