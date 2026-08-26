import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ClaudeContextWindowMode,
  ClaudeLaunchMode,
  ClaudePermissionMode,
  ClaudeProjectState,
  ClaudeRouteHealth,
  ClaudeStreamFailureKind,
  ManagedChatGptContextWindowMode,
  NetworkProviderId,
  PtyGeneration,
  RouterOperationProgress,
} from '../../shared/contracts';
import {
  resolveClaudeRuntimeModel,
  stripClaudeContextWindowSuffix,
} from '../../shared/claude/model-id';
import { isClaudeEffortSafeAfterThinkingDisabledError } from '../../shared/claude/effort';
import { officialNetworkProviderForClaudePreset } from '../../shared/claude/providers';
import { DEFAULT_TERMINAL_THEME, type TerminalThemeId } from '../../shared/ui/terminal-themes';
import {
  buildClaudeEnvironment,
  buildClaudeSettingsEnvironment,
  MODEL_NAME_PATTERN,
  type NormalizedClaudeConfig,
} from './configuration';
import { POWERSHELL_STARTUP_TRIGGER } from '../terminal/session';
import { classifyClaudeStreamFailure } from './stream-diagnostics-store';
import {
  connectionFingerprint,
  projectKey,
  routerBlockingDetail,
  usesDefaultClaudeRouter,
} from './runtime-connection';
import { claudeNetworkAccessForLaunchSnapshot } from './runtime-connection-config';
export {
  connectionProtocolForRouterProvider,
  computeClaudeConnectionAdvice,
  defaultConnectionProtocolForPreset,
  routerBlockingDetail,
  routerRepairInputForProject,
  usesDefaultClaudeRouter,
  usesRemoteRelay,
} from './runtime-connection';
import {
  parseClaudeContextWindowError,
  parseClaudeEffortThinkingDisabledError,
  parseClaudeRuntimeApiError,
} from './runtime-diagnostics';
export {
  parseClaudeContextWindowError,
  parseClaudeEffortThinkingDisabledError,
  parseClaudeRuntimeApiError,
} from './runtime-diagnostics';
import {
  claudeResourceUsage,
  effectiveClaudeMetrics,
  mergeClaudeResourceUsage,
} from './runtime-metrics';
export {
  claudeResourceUsage,
  effectiveClaudeMetrics,
  mergeClaudeResourceUsage,
  parseClaudeMetrics,
} from './runtime-metrics';
import { prepareClaudeLaunchArtifacts } from './runtime-launch-artifacts';
export { claudeCodeThemeForTerminalTheme } from './runtime-launch-artifacts';
import type { ClaudeExecutionEnvironmentPair } from './execution-settings-capabilities';
import type {
  ClaudeExecutionLaunchInput,
  ClaudeExecutionSettingsLaunchResolver,
} from './execution-settings-service';
import { claudeRouteHealth } from './runtime-route-health';
import { modelMatches } from './runtime-controls';
import { claudeOfficialAuthProvider } from './official-auth-status';
import { ClaudeRuntimeConversationModels } from './runtime-conversation-model';
import type { PreparedClaudeLaunchRecord } from './runtime-launch-handoff';
import type { NativeRouteReservation } from './runtime-routing';
import {
  type ClaudeLaunchOverrides,
  type PreparedClaudeLaunch,
  type PreparedNativeClaudeConversation,
  type RuntimeSession,
  sameClaudeNetworkAccess,
} from './runtime-types';
export type {
  PreparedClaudeConfigSave,
  PreparedClaudeLaunch,
  PreparedClaudeSpeedRelaunch,
  PreparedNativeClaudeConversation,
} from './runtime-types';
import type { ClaudeLaunchConfigSnapshot } from './config-store';
import { isConversationId } from '../conversation/preferences-store';
import type { ClaudeRouteKind } from '../coordination/route-lifecycle';

/**
 * How long a resumed conversation gets to paint its TUI before the remembered thinking depth is
 * replayed. A `/effort` written into a terminal that is still booting is simply swallowed.
 */
const EFFORT_RESTORE_DELAY_MS = 2_500;

const longestMarkerPrefixSuffix = (value: string, marker: string): number => {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
};

export class ClaudeRuntime extends ClaudeRuntimeConversationModels {
  private onStreamFailure?: (observation: {
    cliVersion?: string;
    gatewayVersion?: string;
    kind: ClaudeStreamFailureKind;
    occurredAt: number;
    sessionId: string;
    sessionRuntimeMs: number;
  }) => void;
  private permissionHookScriptPath?: string;
  private createPermissionEndpoint?: (
    sessionId: string,
    launchGeneration: number,
  ) => { pipeName: string; token: string };
  private conversationLaunchGuard: (
    cwd: string,
    mode: ClaudeLaunchMode,
    conversationId?: string,
  ) => void = () => {};
  private nextStateRevision = 0;
  private readonly runtimeRoot: string;
  private currentThemeId: TerminalThemeId;

  public constructor(
    userDataPath: string,
    private readonly statusLineScriptPath: string,
    private readonly signalScriptPath: string,
    private readonly webSearchGuardScriptPath: string,
    /**
     * Read per launch, so toggling the workaround in settings takes effect on the next session
     * without a restart.
     */
    private readonly isWebResearchIsolationEnabled: () => boolean,
    private readonly managedChatGptContextWindowMode: () => ManagedChatGptContextWindowMode,
    /** Read per launch so a status-bar window change applies to the next session. */
    private readonly claudeContextWindow: () => {
      customTokens?: number;
      mode: ClaudeContextWindowMode;
    },
    onState: (state: ClaudeProjectState) => void,
    writeToTerminal: (sessionId: string, ptyGeneration: PtyGeneration, data: string) => boolean,
    readPermissionModeFromScreen: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
    ) => Promise<ClaudePermissionMode | undefined>,
    ensureManagedChatGptGatewayReady: (cwd: string) => Promise<boolean | void>,
    managedChatGptGatewayInstalledVersion: () => string | undefined,
    fetchImplementation: typeof fetch = fetch,
    initialThemeId: TerminalThemeId = DEFAULT_TERMINAL_THEME,
    onRouterOperationProgress: (progress: RouterOperationProgress) => void = () => {},
    stopManagedChatGptGateway: () => Promise<void> | void = () => {},
    routerCommandEnvironment: () => Record<string, null | string | undefined> = () => ({}),
    private readonly executionSettingsLaunchResolver?: ClaudeExecutionSettingsLaunchResolver,
  ) {
    super(
      userDataPath,
      onState,
      writeToTerminal,
      readPermissionModeFromScreen,
      managedChatGptGatewayInstalledVersion,
      ensureManagedChatGptGatewayReady,
      fetchImplementation,
      onRouterOperationProgress,
      stopManagedChatGptGateway,
      routerCommandEnvironment,
    );
    this.runtimeRoot = path.join(userDataPath, 'claude', 'runtime');
    this.currentThemeId = initialThemeId;
    this.initializeRuntimePolling();
  }

  public setPermissionRequestHook(
    scriptPath: string,
    createEndpoint: (
      sessionId: string,
      launchGeneration: number,
    ) => { pipeName: string; token: string },
  ): void {
    this.permissionHookScriptPath = scriptPath;
    this.createPermissionEndpoint = createEndpoint;
  }

  public setStreamFailureHandler(handler: NonNullable<ClaudeRuntime['onStreamFailure']>): void {
    this.onStreamFailure = handler;
  }

  public closeSession(sessionId: string): void {
    this.cleanupPreparedLaunch(sessionId);
    const previous = this.sessions.get(sessionId);
    const previousRoute = previous?.routeKind;
    if (previous?.launchGeneration !== undefined && previous.ptyGeneration !== undefined) {
      this.emitSyntheticSessionEnd(previous);
    }
    this.sessions.delete(sessionId);
    if (previousRoute) {
      void this.stopUnusedRoute(previousRoute).catch(() => {});
    }
  }

  public sessionOwnsConversation(sessionId: string, cwd: string, conversationId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.active || projectKey(runtime.cwd) !== projectKey(cwd)) {
      return false;
    }
    const normalizedConversationId = conversationId.toLowerCase();
    return [runtime.conversationId, runtime.metrics?.sessionId].some(
      (candidate) => candidate?.toLowerCase() === normalizedConversationId,
    );
  }

  public sessionIdsForConversation(cwd: string, conversationId: string): string[] {
    return [...this.sessions.values()]
      .filter(({ sessionId }) => this.sessionOwnsConversation(sessionId, cwd, conversationId))
      .map(({ sessionId }) => sessionId);
  }

  public setConversationLaunchGuard(
    guard: (cwd: string, mode: ClaudeLaunchMode, conversationId?: string) => void,
  ): void {
    this.conversationLaunchGuard = guard;
  }

  /** Applies to the next Claude launch; a live Ink TUI is never mutated underneath the user. */
  public setTheme(themeId: TerminalThemeId): void {
    this.currentThemeId = themeId;
  }

  public consumeTerminalOutput(
    sessionId: string,
    ptyGeneration: PtyGeneration,
    data: string,
  ): string {
    const runtime = this.sessions.get(sessionId);
    if (runtime?.ptyGeneration !== ptyGeneration || !runtime.exitMarker) {
      return data;
    }

    runtime.diagnosticBuffer = `${runtime.diagnosticBuffer}${data}`.slice(-4_000);
    const rejectedEffort = parseClaudeEffortThinkingDisabledError(runtime.diagnosticBuffer);
    if (rejectedEffort && !runtime.effortCompatibility) {
      runtime.effortCompatibility = {
        detectedAt: Date.now(),
        maximum: 'high',
        recovery: 'pending',
        rejectedLevel: rejectedEffort,
      };
      void this.recoverEffortAfterThinkingDisabled(runtime, rejectedEffort);
    }
    const detectedError = parseClaudeRuntimeApiError(runtime.diagnosticBuffer);
    const contextWindowExceeded = parseClaudeContextWindowError(runtime.diagnosticBuffer);
    const contextualError =
      detectedError && contextWindowExceeded && runtime.contextWindowMode === 'extended'
        ? `${detectedError} 当前会话启用了实验性的 105 万扩展窗口；这通常表示 ChatGPT 订阅后端仍按较小的产品窗口拒绝请求，请切回标准窗口后新建会话。`
        : detectedError;
    if (contextualError && contextualError !== runtime.lastApiError?.detail) {
      const detectedAt = Date.now();
      runtime.lastApiError = {
        category: rejectedEffort
          ? 'effort-thinking-disabled'
          : contextWindowExceeded
            ? 'context-window-exceeded'
            : 'general',
        detail: contextualError,
        detectedAt,
      };
      const streamFailure = classifyClaudeStreamFailure(contextualError);
      if (streamFailure) {
        this.onStreamFailure?.({
          ...(runtime.launchedCliVersion ? { cliVersion: runtime.launchedCliVersion } : {}),
          ...(this.managedGatewayVersion() ? { gatewayVersion: this.managedGatewayVersion() } : {}),
          kind: streamFailure,
          occurredAt: detectedAt,
          sessionId,
          sessionRuntimeMs: Math.max(0, detectedAt - (runtime.launchedAt ?? detectedAt)),
        });
      }
      void this.emitState(runtime);
    }
    this.observePermissionModeFromRawOutput(runtime);

    let combined = runtime.markerRemainder + data;
    runtime.markerRemainder = '';
    const exitMarker = runtime.exitMarker;
    if (combined.includes(exitMarker)) {
      combined = combined.replaceAll(exitMarker, '');
      this.setInactive(sessionId, ptyGeneration);
    }

    if (runtime.exitMarker) {
      const retainedLength = longestMarkerPrefixSuffix(combined, runtime.exitMarker);
      if (retainedLength > 0) {
        runtime.markerRemainder = combined.slice(-retainedLength);
        return combined.slice(0, -retainedLength);
      }
    }

    return combined;
  }

  public override async getState(sessionId: string, cwd: string): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    for (;;) {
      if (this.sessions.get(sessionId) !== runtime) {
        throw new Error('Claude Code 会话已关闭，这次状态读取已取消。');
      }
      const stateRevision = ++this.nextStateRevision;
      const active = runtime.active;
      const launchGeneration = runtime.launchGeneration;
      const ptyGeneration = runtime.ptyGeneration;
      const runtimeCwd = runtime.cwd;
      const lastApiError = runtime.lastApiError;
      const ownershipIsCurrent = (): boolean =>
        this.sessions.get(sessionId) === runtime &&
        runtime.active === active &&
        runtime.launchGeneration === launchGeneration &&
        runtime.ptyGeneration === ptyGeneration &&
        runtime.cwd === runtimeCwd;

      const installation = await this.diagnoseInstallation();
      if (!ownershipIsCurrent()) {
        continue;
      }
      const config = this.configStore.getConfig(cwd);
      const credential = this.configStore.getCredential(cwd);
      const configFingerprint = connectionFingerprint(config, credential);
      const [providerUsage, routeHealth, officialAuth] = await Promise.all([
        this.resourceUsageService.read(projectKey(cwd), config.preset, credential),
        this.getRouteHealth(runtime, config),
        config.preset === 'anthropic' ? claudeOfficialAuthProvider.getState() : undefined,
      ]);
      if (this.sessions.get(sessionId) !== runtime) {
        throw new Error('Claude Code 会话已关闭，这次状态读取已取消。');
      }
      if (
        !ownershipIsCurrent() ||
        runtime.lastApiError !== lastApiError ||
        connectionFingerprint(
          this.configStore.getConfig(cwd),
          this.configStore.getCredential(cwd),
        ) !== configFingerprint
      ) {
        continue;
      }

      const matches = modelMatches(runtime.expectedModel, runtime.metrics?.modelId);
      const metricsConfig = runtime.expectedModel
        ? { ...config, model: runtime.expectedModel }
        : config;
      const contextWindowMode = runtime.contextWindowMode ?? this.managedChatGptContextWindowMode();
      const displayMetrics = effectiveClaudeMetrics(
        runtime.metrics,
        metricsConfig,
        contextWindowMode,
      );
      const contextUsage = claudeResourceUsage(displayMetrics, metricsConfig, contextWindowMode);
      return {
        active: runtime.active,
        allowBypassPermissions: this.configStore.getAllowBypassPermissions(cwd),
        config: this.configStore.getView(cwd),
        cwd,
        effortCompatibility: runtime.effortCompatibility,
        effortRequest: runtime.effortRequest,
        expectedModel: runtime.expectedModel,
        installation,
        metrics: displayMetrics,
        modelMatches: matches,
        ...(officialAuth ? { officialAuth } : {}),
        permissionMode: runtime.permissionMode,
        permissionModeRequest: runtime.permissionModeRequest,
        permissionModeCycle: [...runtime.permissionModeCycle],
        ptyGeneration: runtime.ptyGeneration,
        resourceUsage: mergeClaudeResourceUsage(contextUsage, providerUsage),
        routeHealth,
        sessionId,
        stateRevision,
        speed: this.modelSpeedState(runtime, config, installation.version),
        warning: matches
          ? undefined
          : `运行中模型 ${runtime.metrics?.modelId ?? '未知'} 与锁定模型 ${runtime.expectedModel} 不一致。`,
      };
    }
  }

  public override async publishProjectState(
    sessionId: string,
    cwd: string,
  ): Promise<ClaudeProjectState> {
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  public isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
  }

  protected override hasActiveRoute(
    routeKind: ClaudeRouteKind,
    excludedSessionId?: string,
  ): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.sessionId !== excludedSessionId &&
        session.active &&
        session.routeKind === routeKind,
    );
  }

  private async resolveExecutionSettingsForLaunch(
    cwd: string,
    config: NormalizedClaudeConfig,
    model: string,
    officialNetworkProvider: NetworkProviderId | undefined,
    processEnvironment: Readonly<Record<string, null | string>>,
    settingsEnvironment: Readonly<Record<string, string>>,
  ): Promise<ClaudeExecutionEnvironmentPair> {
    const capturedProcessEnvironment = Object.freeze({ ...processEnvironment });
    const capturedSettingsEnvironment = Object.freeze({ ...settingsEnvironment });
    const input: ClaudeExecutionLaunchInput = Object.freeze({
      processEnvironment: capturedProcessEnvironment,
      route: Object.freeze({
        model,
        ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
        routeId: JSON.stringify({
          baseUrl: config.baseUrl,
          cwd: projectKey(cwd),
          officialNetworkProvider: officialNetworkProvider ?? null,
          preset: config.preset,
          provider: config.provider,
        }),
      }),
      settingsEnvironment: capturedSettingsEnvironment,
    });
    const resolver = this.executionSettingsLaunchResolver;
    if (!resolver) {
      return Object.freeze({
        processEnvironment: capturedProcessEnvironment,
        settingsEnvironment: capturedSettingsEnvironment,
      });
    }
    return (await resolver.resolveLaunch(input)).environments;
  }

  /**
   * Prepares the same project-owned route and credential environment for the structured Agent SDK
   * lane. The reservation stays live until `releaseNativeConversation` so a PTY teardown cannot
   * stop a shared CCR/managed gateway underneath an active native conversation.
   */
  public async prepareNativeConversation(
    ownerId: string,
    cwd: string,
    requestedModel?: string,
  ): Promise<PreparedNativeClaudeConversation> {
    this.assertLaunchAdmissionAllowed();
    if (this.nativeRouteReservations.has(ownerId)) {
      throw new Error('该原生会话已经持有接入路由。');
    }
    const launchSnapshot = this.configStore.createLaunchSnapshot(cwd);
    const config = launchSnapshot.config;
    const networkAccess = claudeNetworkAccessForLaunchSnapshot(launchSnapshot);
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(config.preset);
    const routeKind = this.routeKindForConfig(config);
    const entry: NativeRouteReservation = {
      phase: 'preparing',
      token: this.routeLifecycle.reserve(ownerId, routeKind),
    };
    // Publish before the first await so duplicate preparation and release can see the exact owner.
    this.nativeRouteReservations.set(ownerId, entry);
    const assertReservationCurrent = (): void => {
      this.assertLaunchAdmissionAllowed();
      if (this.nativeRouteReservations.get(ownerId) !== entry) {
        throw new Error('该原生会话的接入路由准备已取消。');
      }
      if (!this.configStore.launchSnapshotIsCurrent(cwd, launchSnapshot)) {
        throw new Error('Claude 接入配置在原生会话启动期间已更新，请重试。');
      }
    };
    try {
      const installation = await this.diagnoseInstallation(true);
      assertReservationCurrent();
      if (installation.security !== 'ready') throw new Error(installation.message);
      await this.prepareRouteServices(routeKind, ownerId, cwd);
      assertReservationCurrent();
      const credential = launchSnapshot.credential;
      if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
        throw new Error('当前接入需要接口凭据，请先在“接入”页保存密钥。');
      }
      if (usesDefaultClaudeRouter(config)) {
        const router = await this.getRouterHealthState(true);
        assertReservationCurrent();
        const blockingDetail = routerBlockingDetail(config, router);
        if (blockingDetail) throw new Error(blockingDetail);
      }
      const selectedModel = requestedModel ?? config.model;
      if (!MODEL_NAME_PATTERN.test(selectedModel)) throw new Error('模型标识无效。');
      const model = stripClaudeContextWindowSuffix(selectedModel);
      const launchConfig = { ...config, model };
      const speed = this.resolveModelSpeed(launchConfig, model, installation.version);
      const managedContextWindowMode = this.managedChatGptContextWindowMode();
      const claudeContextWindow = this.claudeContextWindow();
      const runtimeModel = resolveClaudeRuntimeModel(
        selectedModel,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      );
      const processEnvironment = buildClaudeEnvironment(
        launchConfig,
        credential,
        managedContextWindowMode,
        speed.profile,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      );
      const settingsEnvironment = buildClaudeSettingsEnvironment(
        launchConfig,
        managedContextWindowMode,
        speed.profile,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      );
      const executionSettings = await this.resolveExecutionSettingsForLaunch(
        cwd,
        launchConfig,
        runtimeModel,
        officialNetworkProvider,
        processEnvironment,
        settingsEnvironment,
      );
      assertReservationCurrent();
      const conversationBinding = await this.currentConversationBinding(cwd, launchSnapshot);
      assertReservationCurrent();
      entry.phase = 'active';
      return {
        allowBypassPermissions: launchSnapshot.allowBypassPermissions,
        cliVersion: installation.version,
        configFingerprint: connectionFingerprint(launchConfig, credential),
        conversationBinding,
        endpointIdentity: `${launchConfig.provider}|${launchConfig.preset}|${launchConfig.baseUrl}`,
        environment: { ...executionSettings.processEnvironment },
        model,
        ...(networkAccess === undefined ? {} : { networkAccess }),
        ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
        runtimeModel,
        settingsEnvironment: { ...executionSettings.settingsEnvironment },
      };
    } catch (error) {
      if (this.nativeRouteReservations.get(ownerId) === entry) {
        this.nativeRouteReservations.delete(ownerId);
        if (this.routeLifecycle.release(entry.token)) {
          void this.stopUnusedRoute(routeKind).catch(() => {});
        }
      }
      throw error;
    }
  }

  public releaseNativeConversation(ownerId: string): void {
    const entry = this.nativeRouteReservations.get(ownerId);
    if (!entry) return;
    this.nativeRouteReservations.delete(ownerId);
    if (this.routeLifecycle.release(entry.token)) {
      void this.stopUnusedRoute(entry.token.routeKind).catch(() => {});
    }
  }

  /** Re-checks the project gate before a live native session can enter bypass mode. */
  public allowsBypassPermissions(cwd: string): boolean {
    return this.configStore.getAllowBypassPermissions(cwd);
  }

  public async prepareLaunch(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    startMode?: ClaudePermissionMode,
    authorization = this.captureLaunchAuthorization(cwd),
  ): Promise<PreparedClaudeLaunch> {
    this.assertLaunchAuthorizationCurrent(cwd, authorization);
    return this.prepareLaunchInternal(
      sessionId,
      cwd,
      mode,
      undefined,
      startMode,
      undefined,
      authorization,
    );
  }

  public async prepareLaunchWithSession(
    sessionId: string,
    cwd: string,
    conversationId: string,
    authorization = this.captureLaunchAuthorization(cwd),
  ): Promise<PreparedClaudeLaunch> {
    this.assertLaunchAuthorizationCurrent(cwd, authorization);
    return this.prepareLaunchInternal(
      sessionId,
      cwd,
      'resume',
      conversationId,
      undefined,
      undefined,
      authorization,
    );
  }

  protected override async prepareLaunchInternal(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    resumeSessionId?: string,
    startMode?: ClaudePermissionMode,
    overrides?: ClaudeLaunchOverrides,
    authorization = this.captureLaunchAuthorization(cwd),
  ): Promise<PreparedClaudeLaunch> {
    this.assertLaunchAdmissionAllowed();
    this.assertLaunchAuthorizationCurrent(cwd, authorization);
    const launchSnapshot = authorization.launchSnapshot;
    const config = launchSnapshot.config;
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(config.preset);
    if (
      officialNetworkProvider !== authorization.officialNetworkProvider ||
      !sameClaudeNetworkAccess(
        claudeNetworkAccessForLaunchSnapshot(launchSnapshot),
        authorization.networkAccess,
      )
    ) {
      throw new Error('Claude 启动快照与已授权网络目标不一致，本次启动已取消。');
    }
    const routeKind = this.routeKindForConfig(config);
    const record = this.reservePreparedLaunch(
      sessionId,
      cwd,
      routeKind,
      authorization,
      this.runtimeRoot,
    );
    try {
      return await this.prepareLaunchWithReservedRoute(
        record,
        cwd,
        mode,
        config,
        launchSnapshot,
        routeKind,
        resumeSessionId,
        startMode,
        overrides,
      );
    } catch (error) {
      this.abortPreparedLaunch(record.token);
      throw error;
    }
  }

  private async prepareLaunchWithReservedRoute(
    record: PreparedClaudeLaunchRecord,
    cwd: string,
    mode: ClaudeLaunchMode,
    config: NormalizedClaudeConfig,
    launchSnapshot: ClaudeLaunchConfigSnapshot,
    routeKind: ClaudeRouteKind,
    resumeSessionId?: string,
    startMode?: ClaudePermissionMode,
    overrides?: ClaudeLaunchOverrides,
  ): Promise<PreparedClaudeLaunch> {
    const { sessionId, generation: launchGeneration } = record.token;
    const assertLaunchSnapshotCurrent = (): void => {
      this.assertLaunchAdmissionAllowed();
      this.assertPreparedLaunchCurrent(record);
    };
    assertLaunchSnapshotCurrent();
    const installation = await this.diagnoseInstallation(true);
    if (installation.security !== 'ready') {
      throw new Error(installation.message);
    }
    assertLaunchSnapshotCurrent();

    await this.prepareRouteServices(routeKind, record.targetRouteReservation.sessionId, cwd);
    assertLaunchSnapshotCurrent();
    const credential = launchSnapshot.credential;
    if ((config.authMode === 'apiKey' || config.authMode === 'authToken') && !credential) {
      throw new Error('当前接入需要接口凭据，请先在“接入”页保存密钥。');
    }
    if (usesDefaultClaudeRouter(config)) {
      const router = await this.getRouterHealthState(true);
      assertLaunchSnapshotCurrent();
      const blockingDetail = routerBlockingDetail(config, router);
      if (blockingDetail) {
        throw new Error(blockingDetail);
      }
    }

    const allowBypass = launchSnapshot.allowBypassPermissions;
    /*
     * Reopening a stored conversation should feel like it never stopped, so the model, permission
     * mode and thinking depth it was last running with win over the project defaults. Bypass is the
     * one exception: it stays gated on the project's own opt-in no matter what was remembered.
     *
     * A `--continue` relaunch keeps the same conversation, so its depth and mode are restored too —
     * but never its model, because a relaunch is how an explicit cross-endpoint switch is applied.
     */
    const resumedConversationId =
      resumeSessionId && isConversationId(resumeSessionId)
        ? resumeSessionId
        : mode === 'continue'
          ? this.sessions.get(sessionId)?.conversationId
          : undefined;
    this.conversationLaunchGuard(cwd, mode, resumedConversationId);
    const remembered = resumedConversationId
      ? this.conversationPreferences.get(resumedConversationId)
      : undefined;
    const rememberedMode =
      remembered?.permissionMode &&
      (remembered.permissionMode !== 'bypassPermissions' || allowBypass)
        ? remembered.permissionMode
        : undefined;
    const effectiveStartMode = startMode ?? rememberedMode;
    const selectedLaunchModel =
      overrides?.model ??
      (mode !== 'continue' && remembered?.model && MODEL_NAME_PATTERN.test(remembered.model)
        ? remembered.model
        : config.model);
    if (!MODEL_NAME_PATTERN.test(selectedLaunchModel)) {
      throw new Error('模型标识不合法，拒绝启动 Claude Code。');
    }
    const launchModel = stripClaudeContextWindowSuffix(selectedLaunchModel);
    const launchConfig = { ...config, model: launchModel };
    const speed = this.resolveModelSpeed(
      launchConfig,
      launchModel,
      installation.version,
      overrides?.speed,
    );
    const contextWindowMode = this.managedChatGptContextWindowMode();
    const claudeContextWindow = this.claudeContextWindow();
    const runtimeModel = resolveClaudeRuntimeModel(
      selectedLaunchModel,
      claudeContextWindow.mode,
      claudeContextWindow.customTokens,
    );

    const {
      activityEventsPath,
      artifactDirectory,
      environment,
      exitMarker,
      metricsPath,
      sessionDirectory,
      settingsPath,
      signalPath,
      turnStopPath,
    } = prepareClaudeLaunchArtifacts({
      activityScriptPath: this.activityScriptPath,
      allowBypass,
      claudeContextWindow,
      config,
      contextWindowMode,
      createPermissionEndpoint: this.createPermissionEndpoint,
      credential,
      isWebResearchIsolationEnabled: this.isWebResearchIsolationEnabled,
      launchConfig,
      launchGeneration,
      mode,
      permissionHookScriptPath: this.permissionHookScriptPath,
      resumeSessionId,
      runtimeLaunchToken: this.runtimeLaunchToken,
      runtimeModel,
      runtimeRoot: this.runtimeRoot,
      sessionId,
      signalScriptPath: this.signalScriptPath,
      speedProfile: speed.profile,
      startMode: effectiveStartMode,
      statusLineScriptPath: this.statusLineScriptPath,
      themeId: this.currentThemeId,
      webSearchGuardScriptPath: this.webSearchGuardScriptPath,
    });
    const executionSettings = await this.resolveExecutionSettingsForLaunch(
      cwd,
      launchConfig,
      runtimeModel,
      record.authorization.officialNetworkProvider,
      environment,
      buildClaudeSettingsEnvironment(
        launchConfig,
        contextWindowMode,
        speed.profile,
        claudeContextWindow.mode,
        claudeContextWindow.customTokens,
      ),
    );

    assertLaunchSnapshotCurrent();
    const conversationBinding = await this.currentConversationBinding(cwd, launchSnapshot);
    assertLaunchSnapshotCurrent();
    if (
      record.artifactDirectory !== artifactDirectory ||
      record.sessionDirectory !== sessionDirectory
    ) {
      throw new Error('Claude 启动产物与准备令牌不一致，本次启动已取消。');
    }

    // The detached replacement is not observable as active until its exact token binds a PTY.
    const replacement: RuntimeSession = {
      active: true,
      activityEventsPath: this.activityScriptPath ? activityEventsPath : undefined,
      artifactDirectory,
      claudeContextWindowCustomTokens: claudeContextWindow.customTokens,
      claudeContextWindowMode: claudeContextWindow.mode,
      contextWindowMode,
      conversationBinding,
      conversationId: resumedConversationId,
      cwd,
      diagnosticBuffer: '',
      effortCompatibility: undefined,
      effortRestoreAfterTurn: undefined,
      effortRestoreInProgress: false,
      // A relaunch re-reads the persisted effort setting, so a session-only request no longer holds.
      effortRequest: undefined,
      exitMarker,
      expectedModel: launchModel,
      lastApiError: undefined,
      launchedAt: Date.now(),
      launchedCliVersion: installation.version,
      launchedConfigFingerprint: connectionFingerprint(config, credential),
      launchedSpeedPreference: speed.preference,
      launchedSpeedSignature: speed.signature,
      launchedSpeedTargetKey: speed.targetKey,
      launchGeneration,
      markerRemainder: '',
      metrics: undefined,
      metricsPath,
      pendingEffortRestore: remembered?.effort,
      pendingEffortRestoreAt: remembered?.effort ? Date.now() + EFFORT_RESTORE_DELAY_MS : undefined,
      permissionMode: effectiveStartMode,
      permissionModeCycle: effectiveStartMode ? [effectiveStartMode] : [],
      permissionModeRequest: effectiveStartMode,
      routeKind,
      runtimeModel,
      sessionId,
      settingsPath,
      signalPath,
      signalSeenAt: undefined,
      thinkingEnabledForHighEffort: false,
      turnStopPath,
      turnStopSeenAt: undefined,
      waitingForCompact: undefined,
    };
    record.replacement = replacement;
    record.phase = 'prepared';
    return {
      command: POWERSHELL_STARTUP_TRIGGER,
      environment: { ...executionSettings.processEnvironment },
      ...(record.authorization.networkAccess === undefined
        ? {}
        : { networkAccess: record.authorization.networkAccess }),
      ...(record.authorization.officialNetworkProvider === undefined
        ? {}
        : { officialNetworkProvider: record.authorization.officialNetworkProvider }),
      predecessorPtyGeneration: record.predecessorPtyGeneration,
      token: record.token,
    };
  }

  public shutdown(): void {
    this.shutdownRuntimePolling();
    this.abortAllPreparedLaunches();
    this.nativeRouteReservations.clear();
    this.sessions.clear();
    this.clearControlState();
    this.routeLifecycle.clear();
  }

  /**
   * High effort is only useful when Claude Code keeps thinking enabled for the request. The
   * command-line settings file is session-local and contains no credential, so it can be updated
   * without changing the user's Claude Code configuration.
   */
  protected override enableThinkingForHighEffort(runtime: RuntimeSession): void {
    if (runtime.thinkingEnabledForHighEffort || !runtime.settingsPath) {
      return;
    }

    const temporaryPath = `${runtime.settingsPath}.thinking-${process.pid}.tmp`;
    try {
      const parsed: unknown = JSON.parse(readFileSync(runtime.settingsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      const settings = parsed as Record<string, unknown>;
      if (settings.alwaysThinkingEnabled !== true) {
        writeFileSync(
          temporaryPath,
          `${JSON.stringify({ ...settings, alwaysThinkingEnabled: true }, null, 2)}\n`,
          'utf8',
        );
        renameSync(temporaryPath, runtime.settingsPath);
      }
      runtime.thinkingEnabledForHighEffort = true;
    } catch {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
      // The runtime fallback still catches the precise API error and safely lowers effort.
    }
  }

  private async recoverEffortAfterThinkingDisabled(
    runtime: RuntimeSession,
    rejectedEffort: 'max' | 'xhigh',
  ): Promise<void> {
    const ptyGeneration = runtime.ptyGeneration;
    if (!runtime.active || ptyGeneration === undefined) {
      return;
    }
    runtime.effortRestoreAfterTurn = runtime.effortRequest ?? rejectedEffort;
    try {
      await this.submitClaudeCommand(runtime, '/effort high');
      this.assertRuntimePty(runtime, ptyGeneration);
      runtime.effortRequest = 'high';
      if (runtime.effortCompatibility) {
        runtime.effortCompatibility = {
          ...runtime.effortCompatibility,
          recovery: 'recovered',
        };
      }
    } catch {
      if (!this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
        return;
      }
      runtime.effortRestoreAfterTurn = undefined;
      if (runtime.effortCompatibility) {
        runtime.effortCompatibility = {
          ...runtime.effortCompatibility,
          recovery: 'failed',
        };
      }
    }
    await this.emitState(runtime);
  }

  protected override async restoreEffortAfterCompatibilityTurn(
    runtime: RuntimeSession,
  ): Promise<void> {
    const restoreTo = runtime.effortRestoreAfterTurn;
    const ptyGeneration = runtime.ptyGeneration;
    if (
      !restoreTo ||
      runtime.effortRestoreInProgress ||
      !runtime.active ||
      ptyGeneration === undefined
    ) {
      return;
    }

    runtime.effortRestoreInProgress = true;
    try {
      if (!isClaudeEffortSafeAfterThinkingDisabledError(restoreTo)) {
        this.enableThinkingForHighEffort(runtime);
      }
      await this.submitClaudeCommand(runtime, `/effort ${restoreTo}`);
      this.assertRuntimePty(runtime, ptyGeneration);
      runtime.diagnosticBuffer = '';
      runtime.effortRequest = restoreTo;
      runtime.effortCompatibility = undefined;
      runtime.effortRestoreAfterTurn = undefined;
      if (runtime.lastApiError?.category === 'effort-thinking-disabled') {
        runtime.lastApiError = undefined;
      }
    } catch {
      // Keep the recovered high cap in place. A later successful Stop signal retries restoration.
    } finally {
      if (this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
        runtime.effortRestoreInProgress = false;
        await this.emitState(runtime);
      }
    }
  }

  private async getRouteHealth(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
  ): Promise<ClaudeRouteHealth | undefined> {
    const credential = this.configStore.getCredential(runtime.cwd);
    const fingerprint = connectionFingerprint(config, credential);
    const configuredHealth = await claudeRouteHealth({
      config,
      fingerprint,
      lastApiError: runtime.lastApiError,
      launchedConfigFingerprint: runtime.launchedConfigFingerprint,
      matchingCheck: this.matchingConnectionCheck(runtime.cwd, fingerprint),
      readRouterHealth: () => this.getRouterHealthState(),
    });
    // A concrete runtime or blocking configuration failure is more specific than the background
    // observer. Otherwise the exact launch's latest advisory snapshot is the live display truth.
    return configuredHealth?.tone === 'error'
      ? configuredHealth
      : (runtime.advisoryRouteHealth ?? configuredHealth);
  }

  protected override async emitState(runtime: RuntimeSession): Promise<void> {
    this.onState(await this.getState(runtime.sessionId, runtime.cwd));
  }

  /**
   * Rides the existing 1-second metrics tick rather than adding a timer. Each read captures both the
   * launch and PTY owner, then checks them again after I/O so an in-flight G1 read cannot mutate G2.
   */
}
