/* eslint-disable max-lines -- Runtime controls keep one session-scoped command state machine together. */
import { randomBytes } from 'node:crypto';
import type {
  ClaudeEffortRequest,
  ClaudeLaunchMode,
  ClaudeModelOption,
  ClaudeModelOptions,
  ClaudeModelSection,
  ClaudePermissionMode,
  ClaudeRelaunchInput,
  ClaudeProjectState,
  ModelSpeedMode,
  ModelSpeedState,
  PtyGeneration,
  RouterOperationProgress,
} from '../../shared/contracts';
import {
  buildTerminalSubmission,
  writeTerminalSubmission,
} from '../../shared/conversation/composer-input';
import {
  CLAUDE_EFFORT_REQUESTS,
  isClaudeEffortSafeAfterThinkingDisabledError,
} from '../../shared/claude/effort';
import {
  claudeModelIdsMatch,
  resolveClaudeRuntimeModel,
  stripClaudeContextWindowSuffix,
} from '../../shared/claude/model-id';
import { isSubscriptionBaseUrl, isSubscriptionProvider } from '../../shared/claude/subscriptions';
import { findClaudeProvider } from '../../shared/claude/providers';
import { parseClaudePermissionMode } from '../../shared/claude/permission-mode';
import { ConversationPreferencesStore, isConversationId } from '../conversation/preferences-store';
import { resolveProviderModelDiscoveryTarget } from '../network/provider-model-discovery';
import { ProviderResourceUsageService } from '../network/provider-resource-usage';
import { MODEL_NAME_PATTERN, type NormalizedClaudeConfig } from './configuration';
import {
  classifyModelSpeed,
  modelSpeedSignature,
  modelSpeedTargetKey,
} from './model-speed-capabilities';
import { ModelSpeedPreferencesStore } from './model-speed-store';
import { ClaudeRuntimeConnectionConfig } from './runtime-connection-config';
import {
  connectionEndpointFingerprint,
  connectionFingerprint,
  describeEndpoint,
  projectKey,
} from './runtime-connection';
import type {
  ClaudeLaunchAuthorization,
  ClaudeLaunchOverrides,
  PreparedClaudeLaunch,
  PreparedClaudeSpeedRelaunch,
  ResolvedModelSpeed,
  RuntimeSession,
} from './runtime-types';

/**
 * Terminal writes that drive Claude Code's own UI. `ESC [Z` is the CBT sequence xterm already sends
 * for Shift+Tab, so stepping the mode from the status bar is byte-identical to pressing the key.
 */
const SHIFT_TAB_SEQUENCE = `${String.fromCharCode(27)}[Z`;
/** Upper bound on Shift+Tab presses when hunting for a mode. The real cycle is far shorter. */
const PERMISSION_MODE_MAX_STEPS = 8;
/** How long one press gets to repaint and survive a temporarily busy renderer before it is a no-op. */
const PERMISSION_MODE_STEP_TIMEOUT_MS = 2_000;
/** On-demand xterm snapshots are cheap, but leave enough time for PTY output to traverse both IPC hops. */
const PERMISSION_MODE_PROBE_INTERVAL_MS = 50;
const COMPACT_TIMEOUT_MS = 120_000;
const COMPACT_INSTRUCTION = '请保留：当前任务目标、已完成的修改、待办的下一步。';
const MODEL_OPTION_TTL_MS = 2 * 60_000;
const MAX_DISCOVERED_MODELS = 256;

interface ModelOptionRecord {
  configFingerprint: string;
  configScope: string;
  cwdKey: string;
  entryId?: string;
  expiresAt: number;
  launchGeneration: number;
  option: ClaudeModelOption;
  ptyGeneration?: PtyGeneration;
  sessionId: string;
  targetSpeed?: ModelSpeedMode;
}

interface CurrentPlatformDiscovery {
  detail?: string;
  models: string[];
  status: ClaudeModelSection['status'];
}

const safeModelIds = (models: readonly (string | undefined)[]): string[] =>
  [
    ...new Set(
      models
        .filter((model): model is string => typeof model === 'string')
        .map((model) => model.trim())
        .filter((model) => MODEL_NAME_PATTERN.test(model)),
    ),
  ].slice(0, MAX_DISCOVERED_MODELS);

export const modelMatches = (expected: string | undefined, actual: string | undefined): boolean => {
  return claudeModelIdsMatch(expected, actual);
};

export abstract class ClaudeRuntimeControls extends ClaudeRuntimeConnectionConfig {
  /** Serialises complete body/return submissions so two UI actions cannot interleave PTY bytes. */
  private readonly commandSubmissionQueues = new Map<string, Promise<void>>();
  protected readonly conversationPreferences: ConversationPreferencesStore;
  private readonly modelSpeedPreferences: ModelSpeedPreferencesStore;
  protected readonly resourceUsageService: ProviderResourceUsageService;
  /** Serialises Shift+Tab stepping per session so two clicks can never interleave presses. */
  private readonly modeSwitchLocks = new Set<string>();
  /** Short-lived descriptors keep renderer-visible IDs unguessable and bound to one live session. */
  private readonly modelOptionRegistry = new Map<string, ModelOptionRecord>();
  protected readonly sessions = new Map<string, RuntimeSession>();

  protected constructor(
    userDataPath: string,
    protected readonly onState: (state: ClaudeProjectState) => void,
    protected readonly writeToTerminal: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
      data: string,
    ) => boolean,
    private readonly readPermissionModeFromScreen: (
      sessionId: string,
      ptyGeneration: PtyGeneration,
    ) => Promise<ClaudePermissionMode | undefined>,
    private readonly managedChatGptGatewayInstalledVersion: () => string | undefined,
    ensureManagedChatGptGatewayReady: (cwd: string) => Promise<boolean | void>,
    fetchImplementation: typeof fetch,
    onRouterOperationProgress: (progress: RouterOperationProgress) => void,
    stopManagedChatGptGateway: () => Promise<void> | void,
    routerCommandEnvironment: () => Record<string, null | string | undefined>,
  ) {
    super(
      userDataPath,
      ensureManagedChatGptGatewayReady,
      fetchImplementation,
      onRouterOperationProgress,
      stopManagedChatGptGateway,
      routerCommandEnvironment,
    );
    this.resourceUsageService = new ProviderResourceUsageService(fetchImplementation);
    this.conversationPreferences = new ConversationPreferencesStore(userDataPath);
    this.modelSpeedPreferences = new ModelSpeedPreferencesStore(userDataPath);
  }

  public abstract getState(sessionId: string, cwd: string): Promise<ClaudeProjectState>;

  protected abstract prepareLaunchInternal(
    sessionId: string,
    cwd: string,
    mode: ClaudeLaunchMode,
    resumeSessionId?: string,
    startMode?: ClaudePermissionMode,
    overrides?: ClaudeLaunchOverrides,
    authorization?: ClaudeLaunchAuthorization,
  ): Promise<PreparedClaudeLaunch>;

  protected abstract enableThinkingForHighEffort(runtime: RuntimeSession): void;

  protected abstract emitState(runtime: RuntimeSession): Promise<void>;

  protected clearControlState(): void {
    this.commandSubmissionQueues.clear();
    this.modelOptionRegistry.clear();
  }

  public removeConversationPreferences(conversationId: string): void {
    this.conversationPreferences.remove(conversationId);
  }

  protected managedGatewayVersion(): string | undefined {
    try {
      return this.managedChatGptGatewayInstalledVersion();
    } catch {
      return undefined;
    }
  }

  protected resolveModelSpeed(
    config: NormalizedClaudeConfig,
    model: string,
    claudeVersion?: string,
    override?: ModelSpeedMode,
  ): ResolvedModelSpeed {
    const target = {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      model,
      preset: config.preset,
      provider: config.provider,
    };
    const capability = classifyModelSpeed({
      claudeVersion,
      config: target,
      managedGatewayVersion: this.managedGatewayVersion(),
      model,
    });
    if (override === 'fast' && !capability.canSelectFast) {
      throw new Error(capability.detail);
    }
    const targetKey = modelSpeedTargetKey(target);
    const preference = override ?? this.modelSpeedPreferences.get(targetKey).mode;
    const appliedMode = preference === 'fast' && capability.canSelectFast ? 'fast' : 'standard';
    return {
      capability,
      preference,
      profile: { mechanism: capability.mechanism, mode: appliedMode },
      signature: modelSpeedSignature(capability, preference),
      targetKey,
    };
  }

  protected modelForSpeedPreference(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
    claudeVersion?: string,
  ): string {
    if (!runtime.active) {
      return config.model;
    }
    const reportedModel = runtime.metrics?.modelId;
    const expectedModel = runtime.expectedModel;
    if (
      expectedModel &&
      expectedModel !== 'default' &&
      modelMatches(expectedModel, reportedModel)
    ) {
      const expectedCapability = classifyModelSpeed({
        claudeVersion,
        config,
        managedGatewayVersion: this.managedGatewayVersion(),
        model: expectedModel,
      });
      if (expectedCapability.availability !== 'unverified') {
        return expectedModel;
      }
    }
    return stripClaudeContextWindowSuffix(reportedModel ?? expectedModel ?? config.model);
  }

  protected modelSpeedState(
    runtime: RuntimeSession,
    config: NormalizedClaudeConfig,
    claudeVersion?: string,
  ): ModelSpeedState {
    const model = this.modelForSpeedPreference(runtime, config, claudeVersion);
    const resolved = this.resolveModelSpeed(config, model, claudeVersion);
    const launchedTarget =
      runtime.active &&
      (runtime.launchedSpeedTargetKey === resolved.targetKey ||
        modelMatches(runtime.expectedModel, model));
    const preference = launchedTarget
      ? (runtime.launchedSpeedPreference ?? resolved.preference)
      : resolved.preference;
    const requestedSignature = modelSpeedSignature(resolved.capability, preference);
    const fastLaunchRequested =
      launchedTarget &&
      requestedSignature !== 'standard' &&
      runtime.launchedSpeedSignature === requestedSignature;
    const officialAnthropic =
      config.provider === 'anthropic' &&
      (config.preset === 'anthropic' || config.preset === 'anthropic-api');

    let detail = resolved.capability.detail;
    let status: ModelSpeedState['status'] = 'standard';
    if (runtime.active && officialAnthropic && runtime.metrics?.fastMode === true) {
      status = 'active';
      if (preference === 'standard') {
        detail =
          'Claude Code 状态行报告当前会话已开启 Fast；ClaudeDock 仍会在下次启动时恢复已保存的标准速度。';
      }
    } else if (resolved.capability.availability === 'available' && preference === 'fast') {
      if (!runtime.active) {
        status = 'requested';
        detail = `${resolved.capability.detail} 已保存，将在下次新建或恢复会话时请求。`;
      } else if (resolved.capability.mechanism === 'gpt-service-tier' && fastLaunchRequested) {
        status = 'requested';
        detail =
          'ClaudeDock 已把 service_tier=fast 写入当前 GPT 会话请求；实际资格和上游是否采用仍由 ChatGPT 决定。';
      } else if (resolved.capability.mechanism === 'claude-native-fast' && fastLaunchRequested) {
        if (runtime.metrics?.fastMode === false) {
          status = 'not-active';
          detail =
            '已请求 Claude Fast，但 Claude Code 状态行报告未生效；请查看终端中的组织权限、额度或模型提示。';
        } else {
          status = 'requested';
          detail = '已请求 Claude Fast，正在等待 Claude Code 状态行确认是否生效。';
        }
      } else {
        status = 'not-active';
        detail = '当前 PowerShell 会话没有使用已保存的快速速度配置，需要重启后才能生效。';
      }
    }

    return {
      availability: resolved.capability.availability,
      canSelectFast: resolved.capability.canSelectFast,
      detail,
      mechanism: resolved.capability.mechanism,
      model,
      preference,
      status,
    };
  }

  protected requireBoundPty(runtime: RuntimeSession): PtyGeneration {
    const ptyGeneration = runtime.ptyGeneration;
    if (!runtime.active || ptyGeneration === undefined) {
      throw new Error('Claude Code 会话已停止或重启，这次操作已取消。');
    }
    return ptyGeneration;
  }

  protected isRuntimePtyCurrent(runtime: RuntimeSession, ptyGeneration: PtyGeneration): boolean {
    return (
      this.sessions.get(runtime.sessionId) === runtime &&
      runtime.active &&
      runtime.ptyGeneration === ptyGeneration
    );
  }

  protected isRuntimeLaunchPtyCurrent(
    runtime: RuntimeSession,
    launchGeneration: number,
    ptyGeneration: PtyGeneration,
  ): boolean {
    return (
      this.isRuntimePtyCurrent(runtime, ptyGeneration) &&
      runtime.launchGeneration === launchGeneration
    );
  }

  protected assertRuntimePty(runtime: RuntimeSession, ptyGeneration: PtyGeneration): void {
    if (!this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
      throw new Error('Claude Code 会话已停止或重启，这次操作已取消。');
    }
  }

  private async discoverCurrentPlatformModels(
    cwd: string,
    configScope: string,
    config: NormalizedClaudeConfig,
  ): Promise<CurrentPlatformDiscovery> {
    const definition = findClaudeProvider(config.preset);
    const fallback = safeModelIds([
      config.model,
      config.modelFast,
      definition?.model,
      definition?.modelFast,
    ]);
    const fallbackDetail = '当前接入未提供可读取的模型目录，已保留配置中的模型。';
    try {
      let models: string[];
      if (config.preset === 'chatgpt-subscription') {
        models = await this.discoverManagedChatGptModels();
      } else if (isSubscriptionProvider(config.preset) && isSubscriptionBaseUrl(config.baseUrl)) {
        models = await this.discoverSubscriptionModels(config.preset, config.baseUrl);
      } else {
        const view = this.configStore.getView(configScope);
        if (view.protocol !== 'openai' && config.provider !== 'gateway') {
          return { detail: fallbackDetail, models: fallback, status: 'fallback' };
        }
        const target = resolveProviderModelDiscoveryTarget(config.baseUrl);
        models = await this.discoverGenericModels(
          cwd,
          target,
          this.configStore.getCredential(configScope),
        );
      }
      const normalized = safeModelIds([...models, ...fallback]);
      if (!normalized.length) throw new Error('当前接口没有返回可用模型。');
      return {
        detail: `已读取 ${normalized.length} 个当前接入平台模型。`,
        models: normalized,
        status: 'discovered',
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '模型目录读取失败。';
      return {
        detail: `${detail} 已保留配置中的模型。`,
        models: fallback,
        status: 'degraded',
      };
    }
  }

  private registerModelOptions(
    cwd: string,
    sessionId: string | undefined,
    configScope: string,
    configFingerprint: string,
    runtime: RuntimeSession | undefined,
    descriptors: readonly {
      entryId?: string;
      option: ClaudeModelOption;
      targetSpeed?: ModelSpeedMode;
    }[],
  ): void {
    const now = Date.now();
    const cwdKey = projectKey(cwd);
    const registrySessionId = sessionId ?? '';
    for (const [id, record] of this.modelOptionRegistry) {
      if (
        record.expiresAt <= now ||
        (record.sessionId === registrySessionId && record.cwdKey === cwdKey)
      ) {
        this.modelOptionRegistry.delete(id);
      }
    }
    for (const { entryId, option, targetSpeed } of descriptors) {
      this.modelOptionRegistry.set(option.id, {
        configFingerprint,
        configScope,
        cwdKey: projectKey(cwd),
        ...(entryId === undefined ? {} : { entryId }),
        expiresAt: now + MODEL_OPTION_TTL_MS,
        launchGeneration: runtime?.launchGeneration ?? 0,
        option,
        ...(runtime?.ptyGeneration === undefined ? {} : { ptyGeneration: runtime.ptyGeneration }),
        sessionId: sessionId ?? '',
        ...(targetSpeed === undefined ? {} : { targetSpeed }),
      });
    }
  }

  private modelOptionRecord(sessionId: string, cwd: string, optionId: string): ModelOptionRecord {
    const record = this.modelOptionRegistry.get(optionId);
    const runtime = this.sessions.get(sessionId);
    const configScope = this.connectionConfigScope(sessionId, cwd);
    const config = this.configStore.getConfig(configScope);
    const currentFingerprint = connectionFingerprint(
      config,
      this.configStore.getCredential(configScope),
    );
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      record.sessionId !== sessionId ||
      record.cwdKey !== projectKey(cwd) ||
      record.configScope !== configScope ||
      record.configFingerprint !== currentFingerprint ||
      record.launchGeneration !== (runtime?.launchGeneration ?? 0) ||
      record.ptyGeneration !== runtime?.ptyGeneration
    ) {
      if (record && record.expiresAt <= Date.now()) this.modelOptionRegistry.delete(optionId);
      throw new Error('这个模型选项已经失效，请重新打开列表。');
    }
    return record;
  }

  /** Resolves a relaunch option without exposing its history entry or credential to the renderer. */
  public relaunchInputForModelOption(
    sessionId: string,
    cwd: string,
    input: ClaudeRelaunchInput,
  ): ClaudeRelaunchInput {
    if (!input.modelOptionId) return input;
    const record = this.modelOptionRecord(sessionId, cwd, input.modelOptionId);
    if (!record.option.requiresRelaunch) {
      throw new Error('这个模型选项不需要重启会话。');
    }
    const withoutOptionId = { ...input };
    delete withoutOptionId.entryId;
    delete withoutOptionId.modelOptionId;
    delete withoutOptionId.model;
    delete withoutOptionId.speed;
    if (record.entryId !== undefined) {
      return { ...withoutOptionId, entryId: record.entryId };
    }
    if (record.option.section !== 'current-platform' || !record.option.sameEndpoint) {
      throw new Error('这个模型选项缺少安全的重启目标。');
    }
    return {
      ...withoutOptionId,
      model: record.option.model,
      ...(record.targetSpeed === undefined ? {} : { speed: record.targetSpeed }),
    };
  }

  /**
   * Everything the status-bar picker can offer, split into models from the current platform and
   * previously saved connections. Discovery is main-owned; the renderer receives only opaque IDs.
   */
  public async getModelOptions(cwd: string, sessionId?: string): Promise<ClaudeModelOptions> {
    const configScope = sessionId ? this.connectionConfigScope(sessionId, cwd) : cwd;
    const config = this.configStore.getConfig(configScope);
    const configView = this.configStore.getView(configScope);
    const runtime = sessionId ? this.sessions.get(sessionId) : undefined;
    const installation = await this.diagnoseInstallation();
    const activeModel = runtime?.expectedModel ?? runtime?.metrics?.modelId ?? config.model;
    const launchedSignature = runtime?.launchedSpeedSignature ?? 'standard';
    const configFingerprint = connectionFingerprint(
      config,
      this.configStore.getCredential(configScope),
    );
    const discovery = await this.discoverCurrentPlatformModels(cwd, configScope, config);
    const relaunchMetadata = (
      targetConfig: NormalizedClaudeConfig,
      sameEndpoint: boolean,
    ): Pick<ClaudeModelOption, 'relaunchReason' | 'requiresRelaunch'> & {
      targetSpeed?: ModelSpeedMode;
    } => {
      if (!sameEndpoint) return { relaunchReason: 'connection', requiresRelaunch: true };
      const targetSpeed = this.resolveModelSpeed(
        targetConfig,
        targetConfig.model,
        installation.version,
      );
      return runtime?.active && targetSpeed.signature !== launchedSignature
        ? {
            relaunchReason: 'speed-profile',
            requiresRelaunch: true,
            targetSpeed: targetSpeed.preference,
          }
        : { requiresRelaunch: false };
    };
    const descriptors: {
      entryId?: string;
      option: ClaudeModelOption;
      targetSpeed?: ModelSpeedMode;
    }[] = [];
    const seen = new Set<string>();
    const addOption = (
      model: string,
      providerLabel: string,
      source: ClaudeModelOption['source'],
      section: ClaudeModelOption['section'],
      targetConfig: NormalizedClaudeConfig,
      sameEndpoint: boolean,
      entryId?: string,
    ): void => {
      const canonicalModel =
        section === 'current-platform' ? stripClaudeContextWindowSuffix(model) : model;
      const dedupeKey =
        entryId === undefined ? `${section}|${canonicalModel}` : `${section}|${entryId}`;
      if (!MODEL_NAME_PATTERN.test(canonicalModel) || seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      const id = `model-${randomBytes(18).toString('base64url')}`;
      const relaunch = relaunchMetadata({ ...targetConfig, model: canonicalModel }, sameEndpoint);
      const { targetSpeed, ...optionRelaunch } = relaunch;
      const option: ClaudeModelOption = {
        action: relaunch.requiresRelaunch ? 'relaunch' : 'switch',
        id,
        label: canonicalModel,
        model: canonicalModel,
        providerLabel,
        ...optionRelaunch,
        sameEndpoint,
        section,
        source,
      };
      descriptors.push({
        ...(entryId === undefined ? {} : { entryId }),
        option,
        ...(targetSpeed === undefined ? {} : { targetSpeed }),
      });
    };

    for (const model of safeModelIds([activeModel, ...discovery.models])) {
      const isActiveModel = modelMatches(activeModel, model);
      addOption(
        model,
        isActiveModel ? '当前接入' : configView.protocol === 'openai' ? '当前平台发现' : '当前平台',
        isActiveModel ? 'active' : discovery.status === 'discovered' ? 'discovered' : 'fallback',
        'current-platform',
        { ...config, model },
        true,
      );
    }

    const currentEndpointConfig: NormalizedClaudeConfig =
      configView.protocol === 'openai' && configView.sourceBaseUrl
        ? {
            ...config,
            authMode: configView.sourceAuthMode ?? config.authMode,
            baseUrl: configView.sourceBaseUrl,
          }
        : config;
    const currentEndpointCredential =
      configView.protocol === 'openai' && configView.sourceBaseUrl
        ? this.configStore.getSourceCredential(configScope)
        : this.configStore.getCredential(configScope);
    const currentEndpointIdentity = connectionEndpointFingerprint(
      currentEndpointConfig,
      currentEndpointCredential,
      configView.routerProviderId,
      configView.protocol,
    );
    const historyEndpointFingerprints = this.connectionHistoryEndpointFingerprints(cwd);
    for (const entry of this.getConnectionHistory(cwd)) {
      const entryConfig: NormalizedClaudeConfig = {
        apiKeyHelperPolicy: entry.apiKeyHelperPolicy,
        authMode: entry.authMode,
        baseUrl: entry.baseUrl,
        model: entry.model,
        modelFast: entry.modelFast,
        preset: entry.preset,
        provider: entry.provider,
      };
      const sameEndpoint = historyEndpointFingerprints.get(entry.id) === currentEndpointIdentity;
      addOption(
        entry.model,
        describeEndpoint(entry),
        'history',
        'history',
        entryConfig,
        sameEndpoint,
        entry.id,
      );
    }

    this.registerModelOptions(cwd, sessionId, configScope, configFingerprint, runtime, descriptors);
    return {
      activeModel: stripClaudeContextWindowSuffix(activeModel),
      options: descriptors.map(({ option }) => option),
      sections: [
        {
          detail: discovery.detail,
          id: 'current-platform',
          label: '当前接入平台的其他模型',
          status: discovery.status,
        },
        {
          detail: descriptors.some(({ option }) => option.section === 'history')
            ? undefined
            : '暂无可恢复的历史接入。',
          id: 'history',
          label: '用户曾经接入的模型',
          status: 'history',
        },
      ],
    };
  }

  /**
   * Same-endpoint switch: `/model` applies immediately inside the running conversation. The model
   * is re-validated here rather than trusted from the renderer, because this writes to a live shell.
   */
  public async switchModel(
    sessionId: string,
    cwd: string,
    optionId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);

    const optionRecord = this.modelOptionRecord(sessionId, cwd, optionId);
    const option = optionRecord.option;
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    if (option.requiresRelaunch) {
      throw new Error(
        option.relaunchReason === 'speed-profile'
          ? '这个模型保存的服务速度配置与当前 PowerShell 不同，需要重启会话才能切换。'
          : '这个模型属于其他接入端点，需要重启会话才能切换。',
      );
    }
    if (!MODEL_NAME_PATTERN.test(option.model)) {
      throw new Error('模型标识不合法，拒绝写入终端。');
    }
    const canonicalModel = stripClaudeContextWindowSuffix(option.model);
    if (!MODEL_NAME_PATTERN.test(canonicalModel)) {
      throw new Error('模型标识不合法，拒绝写入终端。');
    }
    const installation = await this.diagnoseInstallation();
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    const configScope = this.connectionConfigScope(sessionId, cwd);
    const currentConfig = this.configStore.getConfig(configScope);
    const credential = this.configStore.getCredential(configScope);
    const targetConfig = { ...currentConfig, model: canonicalModel };
    const targetSpeed = this.resolveModelSpeed(targetConfig, canonicalModel, installation.version);
    const runtimeModel = resolveClaudeRuntimeModel(
      option.model,
      runtime.claudeContextWindowMode ?? 'auto',
      runtime.claudeContextWindowCustomTokens,
    );

    await this.submitClaudeCommand(runtime, `/model ${runtimeModel}`, assertCurrent);
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    runtime.expectedModel = canonicalModel;
    runtime.runtimeModel = runtimeModel;
    runtime.launchedConfigFingerprint = connectionFingerprint(targetConfig, credential);
    runtime.launchedSpeedPreference = targetSpeed.preference;
    runtime.launchedSpeedSignature = targetSpeed.signature;
    runtime.launchedSpeedTargetKey = targetSpeed.targetKey;
    runtime.diagnosticBuffer = '';
    runtime.effortCompatibility = undefined;
    runtime.effortRestoreAfterTurn = undefined;
    runtime.lastApiError = undefined;
    this.captureConversationPreferences(runtime);
    const state = await this.getState(sessionId, cwd);
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  /**
   * `/effort` applies inside the running conversation, so no relaunch is needed for any level. The
   * requested value is remembered until the status line reports what Claude Code actually applied:
   * a model that does not support the level silently falls back to the highest one it does support,
   * and `ultracode` reports back as plain `xhigh`.
   */
  public async setEffort(
    sessionId: string,
    cwd: string,
    effort: ClaudeEffortRequest,
    assertCurrent: () => void = () => undefined,
  ): Promise<ClaudeProjectState> {
    assertCurrent();
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    if (!CLAUDE_EFFORT_REQUESTS.has(effort)) {
      throw new Error('思考程度标识不合法，拒绝写入终端。');
    }
    if (runtime.effortCompatibility && !isClaudeEffortSafeAfterThinkingDisabledError(effort)) {
      throw new Error(
        '当前会话已检测到高档思考与 thinking 关闭冲突；为避免请求再次失败，只能选择“均衡”或更低档位。',
      );
    }
    if (!isClaudeEffortSafeAfterThinkingDisabledError(effort)) {
      this.enableThinkingForHighEffort(runtime);
    }

    assertCurrent();
    await this.submitClaudeCommand(runtime, `/effort ${effort}`, assertCurrent);
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    runtime.effortRequest = effort;
    // A relaunch of this conversation should come back at the depth just chosen, not the default.
    runtime.pendingEffortRestore = undefined;
    runtime.pendingEffortRestoreAt = undefined;
    if (runtime.effortCompatibility) {
      runtime.effortCompatibility = {
        ...runtime.effortCompatibility,
        recovery: 'recovered',
      };
    }
    this.captureConversationPreferences(runtime);
    const state = await this.getState(sessionId, cwd);
    assertCurrent();
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  /**
   * Runs a command that has already passed the main-process command/argument whitelist. Keeping the
   * actual PTY submission here gives model switching, compaction, and command-palette actions the
   * same ordering and stale-session guarantees.
   */
  public async runCommand(
    sessionId: string,
    cwd: string,
    commandLine: string,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    await this.submitClaudeCommand(runtime, commandLine);
    this.assertRuntimePty(runtime, ptyGeneration);
    const state = await this.getState(sessionId, cwd);
    this.assertRuntimePty(runtime, ptyGeneration);
    this.onState(state);
    return state;
  }

  public async saveModelSpeedPreference(
    sessionId: string,
    cwd: string,
    mode: ModelSpeedMode,
  ): Promise<ClaudeProjectState> {
    const runtime = this.ensureSession(sessionId, cwd);
    if (runtime.active) {
      throw new Error('Claude Code 正在运行；调整服务速度需要精确恢复当前对话。');
    }
    const configScope = this.connectionConfigScope(sessionId, cwd);
    const launchSnapshot = this.configStore.createLaunchSnapshot(configScope);
    const { config } = launchSnapshot;
    const installation = await this.diagnoseInstallation();
    if (!this.configStore.launchSnapshotIsCurrent(configScope, launchSnapshot)) {
      throw new Error('Claude 接入配置在保存速度偏好期间已更新，请重试。');
    }
    const resolved = this.resolveModelSpeed(config, config.model, installation.version, mode);
    this.modelSpeedPreferences.set(resolved.targetKey, mode);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  public async prepareModelSpeedRelaunch(
    sessionId: string,
    cwd: string,
    mode: ModelSpeedMode,
    authorization = this.captureLaunchAuthorization(this.connectionConfigScope(sessionId, cwd)),
  ): Promise<PreparedClaudeSpeedRelaunch> {
    const configScope = this.connectionConfigScope(sessionId, cwd);
    this.assertLaunchAuthorizationCurrent(configScope, authorization);
    const runtime = this.ensureSession(sessionId, cwd);
    if (!runtime.active) {
      throw new Error('Claude Code 尚未运行；请直接保存下次启动使用的服务速度。');
    }
    const conversationId = runtime.metrics?.sessionId ?? runtime.conversationId;
    if (!conversationId || !isConversationId(conversationId)) {
      throw new Error('当前对话尚未上报可恢复的会话标识，请稍候再调整服务速度。');
    }
    const { launchSnapshot } = authorization;
    const { config } = launchSnapshot;
    const installation = await this.diagnoseInstallation();
    this.assertLaunchAuthorizationCurrent(configScope, authorization);
    const model = this.modelForSpeedPreference(runtime, config, installation.version);
    const resolved = this.resolveModelSpeed(config, model, installation.version, mode);
    const prepared = await this.prepareLaunchInternal(
      sessionId,
      cwd,
      'resume',
      conversationId,
      undefined,
      { model, speed: mode },
      authorization,
    );
    return {
      ...prepared,
      preference: resolved.preference,
      targetKey: resolved.targetKey,
    };
  }

  public async commitModelSpeedPreference(
    sessionId: string,
    cwd: string,
    targetKey: string,
    mode: ModelSpeedMode,
  ): Promise<ClaudeProjectState> {
    this.modelSpeedPreferences.set(targetKey, mode);
    const state = await this.getState(sessionId, cwd);
    this.onState(state);
    return state;
  }

  /** Completes the optional live `/compact` before a relaunch; it never mutates the project profile. */
  public async compactBeforeRelaunch(
    sessionId: string,
    cwd: string,
    compactFirst: boolean,
    assertCurrent: () => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = this.ensureSession(sessionId, cwd);
    assertCurrent();
    if (compactFirst && runtime.active) {
      await this.compactAndWait(runtime, assertCurrent, signal);
      assertCurrent();
    }
  }

  /**
   * Walks the Shift+Tab cycle one press at a time, taking an on-demand xterm snapshot before and
   * after every press. A passive output event is not a sufficient barrier: it can be delayed, and
   * Shift+Tab is contextual when Claude is showing a picker or confirmation dialog. If the badge is
   * not currently visible, no key is sent. Re-visiting a mode proves the live cycle is exhausted.
   */
  public async setPermissionMode(
    sessionId: string,
    cwd: string,
    mode: ClaudePermissionMode,
    assertCurrent: () => void = () => undefined,
  ): Promise<ClaudeProjectState> {
    assertCurrent();
    const runtime = this.ensureSession(sessionId, cwd);
    const ptyGeneration = this.requireBoundPty(runtime);
    if (mode === 'dontAsk') {
      throw new Error('「仅预批准」不在 Shift+Tab 循环内，需要重启会话才能进入。');
    }
    if (
      mode === 'bypassPermissions' &&
      !this.configStore.getAllowBypassPermissions(this.connectionConfigScope(sessionId, cwd))
    ) {
      throw new Error('当前项目关闭了「完全允许」预置；请在工作台开启后重新启动会话。');
    }
    if (this.modeSwitchLocks.has(sessionId)) {
      throw new Error('上一次模式切换还没有完成，请稍候。');
    }

    assertCurrent();
    this.modeSwitchLocks.add(sessionId);
    runtime.permissionModeRequest = mode;
    void this.emitState(runtime).catch(() => {});
    try {
      const current = await this.readPermissionModeFromScreen(sessionId, ptyGeneration);
      assertCurrent();
      this.assertRuntimePty(runtime, ptyGeneration);
      if (!current) {
        throw new Error(
          '当前终端没有显示权限模式徽标。请先关闭 Claude Code 的选择器或确认框，回到主输入界面后重试。',
        );
      }
      this.recordPermissionMode(runtime, current);
      if (current === mode) {
        const state = await this.getState(sessionId, cwd);
        assertCurrent();
        this.assertRuntimePty(runtime, ptyGeneration);
        return state;
      }

      const visited = new Set<ClaudePermissionMode>([current]);
      for (let step = 0; step < PERMISSION_MODE_MAX_STEPS; step += 1) {
        assertCurrent();
        this.assertRuntimePty(runtime, ptyGeneration);
        const before = runtime.permissionMode ?? current;
        if (!this.writeToTerminal(sessionId, ptyGeneration, SHIFT_TAB_SEQUENCE)) {
          throw new Error('Claude Code 会话已停止或重启，这次模式切换已取消。');
        }
        const changed = await this.waitForPermissionModeChange(
          runtime,
          ptyGeneration,
          before,
          assertCurrent,
        );
        assertCurrent();
        this.assertRuntimePty(runtime, ptyGeneration);
        if (!changed) {
          throw new Error(
            '当前终端没有确认这次模式切换，已停止继续按键以避免切到错误模式。请回到 Claude Code 主输入界面后重试；若刚进入「完全允许」，请先在终端完成 Claude Code 自己的模式确认。',
          );
        }
        this.recordPermissionMode(runtime, changed);
        if (changed === mode) {
          const state = await this.getState(sessionId, cwd);
          assertCurrent();
          this.assertRuntimePty(runtime, ptyGeneration);
          this.onState(state);
          return state;
        }
        if (visited.has(changed)) {
          throw new Error('该模式不在当前会话的可用循环中。');
        }
        visited.add(changed);
      }
      throw new Error('该模式不在当前会话的可用循环中。');
    } finally {
      if (runtime.permissionMode !== mode) {
        runtime.permissionModeRequest = undefined;
        void this.emitState(runtime).catch(() => {});
      }
      this.modeSwitchLocks.delete(sessionId);
    }
  }

  public commitAllowBypassPermissions(cwd: string, allowed: boolean, sessionId?: string): void {
    this.configStore.setAllowBypassPermissions(cwd, allowed);
    if (sessionId) {
      this.configStore.setAllowBypassPermissions(
        this.connectionConfigScope(sessionId, cwd),
        allowed,
      );
    }
  }

  /**
   * Accepts the badge reconstructed by xterm. Claude Code normally repaints only changed cells, so
   * the complete viewport is the reliable source after a Shift+Tab step.
   */
  public observePermissionModeFromScreen(
    sessionId: string,
    cwd: string,
    ptyGeneration: PtyGeneration,
    mode: ClaudePermissionMode,
  ): void {
    const runtime = this.ensureSession(sessionId, cwd);
    if (this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
      this.recordPermissionMode(runtime, mode);
    }
  }

  /** A full raw repaint remains a useful startup fallback before xterm reports its first screen. */
  protected observePermissionModeFromRawOutput(runtime: RuntimeSession): void {
    if (runtime.permissionMode !== undefined) {
      return;
    }
    const mode = parseClaudePermissionMode(runtime.diagnosticBuffer);
    if (mode) {
      this.recordPermissionMode(runtime, mode);
    }
  }

  private recordPermissionMode(runtime: RuntimeSession, mode: ClaudePermissionMode): void {
    if (mode === runtime.permissionMode) {
      return;
    }
    runtime.permissionMode = mode;
    if (!runtime.permissionModeCycle.includes(mode)) {
      runtime.permissionModeCycle.push(mode);
    }
    this.captureConversationPreferences(runtime);
    void this.emitState(runtime).catch(() => {});
  }

  /**
   * Mirrors the live status bar into per-conversation storage. Reopening the conversation from the
   * history list then restores exactly what it was running with, instead of the project defaults.
   */
  protected captureConversationPreferences(runtime: RuntimeSession): void {
    const conversationId = runtime.metrics?.sessionId ?? runtime.conversationId;
    if (!conversationId || !isConversationId(conversationId)) {
      return;
    }
    runtime.conversationId = conversationId;
    const model = runtime.metrics?.modelId ?? runtime.expectedModel;
    this.conversationPreferences.record(conversationId, {
      binding: runtime.conversationBinding,
      effort: runtime.effortRequest ?? runtime.metrics?.effortLevel,
      model: model ? stripClaudeContextWindowSuffix(model) : undefined,
      permissionMode: runtime.permissionMode,
    });
  }

  /**
   * Sends the depth remembered for a resumed conversation, once and only once the status line proves
   * the TUI is alive and reports something different from what was asked for.
   */
  protected replayRememberedEffort(runtime: RuntimeSession): void {
    const desired = runtime.pendingEffortRestore;
    const ptyGeneration = runtime.ptyGeneration;
    if (!desired || !runtime.active || ptyGeneration === undefined) {
      return;
    }
    if (runtime.pendingEffortRestoreAt && Date.now() < runtime.pendingEffortRestoreAt) {
      return;
    }
    runtime.pendingEffortRestore = undefined;
    runtime.pendingEffortRestoreAt = undefined;
    if (runtime.metrics?.effortLevel === desired) {
      runtime.effortRequest = desired;
      return;
    }
    void (async () => {
      try {
        if (!isClaudeEffortSafeAfterThinkingDisabledError(desired)) {
          this.enableThinkingForHighEffort(runtime);
        }
        await this.submitClaudeCommand(runtime, `/effort ${desired}`);
        this.assertRuntimePty(runtime, ptyGeneration);
        runtime.effortRequest = desired;
        await this.emitState(runtime);
        this.assertRuntimePty(runtime, ptyGeneration);
      } catch {
        // Restoring the remembered depth is best effort; the session still runs at its default.
      }
    })();
  }

  private waitForPermissionModeChange(
    runtime: RuntimeSession,
    ptyGeneration: PtyGeneration,
    before: ClaudePermissionMode | undefined,
    assertCurrent: () => void,
  ): Promise<ClaudePermissionMode | undefined> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const probe = async (): Promise<void> => {
        try {
          assertCurrent();
          this.assertRuntimePty(runtime, ptyGeneration);
          const observed = await this.readPermissionModeFromScreen(
            runtime.sessionId,
            ptyGeneration,
          );
          assertCurrent();
          this.assertRuntimePty(runtime, ptyGeneration);
          if (observed && observed !== before) {
            resolve(observed);
            return;
          }
          if (Date.now() - startedAt >= PERMISSION_MODE_STEP_TIMEOUT_MS) {
            resolve(undefined);
            return;
          }
          setTimeout(() => {
            void probe();
          }, PERMISSION_MODE_PROBE_INTERVAL_MS);
        } catch (error) {
          reject(error);
        }
      };
      void probe();
    });
  }

  /**
   * Issues `/compact` and waits for the PostCompact hook. A timeout is not fatal — the relaunch is
   * still safe, it just carries the un-compacted history — so the caller is never blocked.
   */
  private async compactAndWait(
    runtime: RuntimeSession,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const ptyGeneration = this.requireBoundPty(runtime);
    let abortListener: (() => void) | undefined;
    let finish!: (error?: unknown) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let waiter: RuntimeSession['waitingForCompact'];
    const compacted = new Promise<unknown | undefined>((resolve) => {
      finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
        if (runtime.waitingForCompact === waiter) {
          runtime.waitingForCompact = undefined;
        }
        resolve(error);
      };
      waiter = () => {
        finish();
      };
      runtime.waitingForCompact = waiter;
      timer = setTimeout(() => {
        finish();
      }, COMPACT_TIMEOUT_MS);
      timer.unref?.();
      if (signal) {
        abortListener = () => {
          finish(signal.reason ?? new Error('这次重启操作已取消。'));
        };
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener('abort', abortListener, { once: true });
        }
      }
    });
    try {
      assertCurrent();
      await this.submitClaudeCommand(runtime, `/compact ${COMPACT_INSTRUCTION}`, assertCurrent);
      const compactError = await compacted;
      if (compactError !== undefined) {
        throw compactError;
      }
      assertCurrent();
      this.assertRuntimePty(runtime, ptyGeneration);
    } catch (error) {
      finish(error);
      const cancellationReason = signal?.reason;
      throw signal?.aborted && cancellationReason instanceof Error ? cancellationReason : error;
    }
  }

  /**
   * Claude Code's TUI treats command text and a trailing return received in one PTY chunk as a
   * paste, which can leave `/model ...` sitting in the input box forever. Queue complete submissions
   * per session, then write the return separately after the shared TUI-safe gap.
   */
  protected submitClaudeCommand(
    runtime: RuntimeSession,
    commandLine: string,
    assertCurrent?: () => void,
  ): Promise<void> {
    const { sessionId } = runtime;
    const ptyGeneration = this.requireBoundPty(runtime);
    const previous = this.commandSubmissionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        let writeFailed = false;
        const isCurrentSession = (): boolean => {
          try {
            assertCurrent?.();
          } catch {
            return false;
          }
          return !writeFailed && this.isRuntimePtyCurrent(runtime, ptyGeneration);
        };
        const submission = buildTerminalSubmission(commandLine);
        let bodyWritten = false;
        const submitted = await writeTerminalSubmission(
          submission,
          (data) => {
            const wrote = this.writeToTerminal(sessionId, ptyGeneration, data);
            if (!wrote) {
              writeFailed = true;
            } else if (submission.body && data === submission.body) {
              bodyWritten = true;
            }
          },
          isCurrentSession,
        );
        if (!submitted || writeFailed) {
          // If cancellation lands in the TUI-safe body/return gap, neutralize only the exact live
          // input line. Never send the clear sequence into a replacement PTY generation.
          if (bodyWritten && this.isRuntimePtyCurrent(runtime, ptyGeneration)) {
            this.writeToTerminal(sessionId, ptyGeneration, '\x15');
          }
          throw new Error('Claude Code 会话已停止或重启，已取消这次命令。');
        }
        this.assertRuntimePty(runtime, ptyGeneration);
      });
    this.commandSubmissionQueues.set(sessionId, current);
    return current.finally(() => {
      if (this.commandSubmissionQueues.get(sessionId) === current) {
        this.commandSubmissionQueues.delete(sessionId);
      }
    });
  }
}
