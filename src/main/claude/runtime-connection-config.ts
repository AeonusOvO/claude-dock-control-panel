import type {
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeProjectState,
  ClaudeRouterManagementState,
  NetworkProviderId,
  RouterOperationProgress,
  SaveClaudeConfigInput,
} from '../../shared/contracts';
import {
  completeConnectionEndpoint,
  routerProtocolForOpenAiEndpoint,
} from '../../shared/router/connection-endpoint';
import {
  findClaudeProvider,
  officialNetworkProviderForClaudePreset,
} from '../../shared/claude/providers';
import type { CcSwitchProviderExportInput } from './cc-switch-adapter';
import { testClaudeConnection } from './connection-test';
import type { ClaudeConfigSnapshot } from './config-store';
import { ClaudeConnectionHistoryStore } from './connection-history';
import { MODEL_NAME_PATTERN, normalizeClaudeConfig } from './configuration';
import {
  connectionFingerprint,
  customRouterProviderName,
  defaultConnectionProtocolForPreset,
  projectKey,
} from './runtime-connection';
import { ClaudeRuntimeRouting } from './runtime-routing';
import type {
  ConnectionCheckRecord,
  ConnectionHistoryMetadata,
  PreparedClaudeConfigSave,
  PreparedOpenAiConnection,
  RuntimeSession,
} from './runtime-types';

export abstract class ClaudeRuntimeConnectionConfig extends ClaudeRuntimeRouting {
  private readonly connectionChecks = new Map<string, ConnectionCheckRecord>();
  private readonly historyStore: ClaudeConnectionHistoryStore;

  protected constructor(
    userDataPath: string,
    ensureManagedChatGptGatewayReady: () => Promise<void>,
    fetchImplementation: typeof fetch,
    applicationVersion: string | undefined,
    onRouterOperationProgress: (progress: RouterOperationProgress) => void,
    stopManagedChatGptGateway: () => Promise<void> | void,
    routerCommandEnvironment: () => Record<string, null | string | undefined>,
  ) {
    super(
      userDataPath,
      ensureManagedChatGptGatewayReady,
      fetchImplementation,
      applicationVersion,
      onRouterOperationProgress,
      stopManagedChatGptGateway,
      routerCommandEnvironment,
    );
    this.historyStore = new ClaudeConnectionHistoryStore(userDataPath);
  }

  protected abstract ensureSession(sessionId: string, cwd: string): RuntimeSession;

  public abstract publishProjectState(sessionId: string, cwd: string): Promise<ClaudeProjectState>;

  protected matchingConnectionCheck(
    cwd: string,
    fingerprint: string,
  ): ClaudeConnectionTestResult | undefined {
    const connectionCheck = this.connectionChecks.get(projectKey(cwd));
    return connectionCheck?.fingerprint === fingerprint ? connectionCheck.result : undefined;
  }

  public officialNetworkProvider(cwd: string): NetworkProviderId | undefined {
    return officialNetworkProviderForClaudePreset(this.configStore.getConfig(cwd).preset);
  }

  public currentProviderForCcSwitch(cwd: string): CcSwitchProviderExportInput {
    const config = this.configStore.getConfig(cwd);
    const view = this.configStore.getView(cwd);
    if (view.protocol === 'openai' || view.routerProviderId) {
      throw new Error(
        '当前上游凭据由 CCR 保存且不会回显；请改用一键接入向导重新填写 Key 后再导出。',
      );
    }
    const provider = findClaudeProvider(config.preset);
    return {
      authMode: config.authMode,
      baseUrl: config.baseUrl,
      credential: this.configStore.getCredential(cwd),
      model: config.model,
      modelFast: config.modelFast,
      name: provider?.label ?? config.preset,
    };
  }

  public connectionHistoryOfficialNetworkProvider(
    cwd: string,
    entryId: string,
  ): NetworkProviderId | undefined {
    return officialNetworkProviderForClaudePreset(
      this.historyStore.toSaveInput(cwd, entryId).preset,
    );
  }

  public createConfigSnapshot(cwd: string): ClaudeConfigSnapshot {
    return this.configStore.createSnapshot(cwd);
  }

  public restoreConfigSnapshot(cwd: string, snapshot: ClaudeConfigSnapshot): void {
    this.configStore.restoreSnapshot(cwd, snapshot);
  }

  public async prepareConnectionConfig(
    input: SaveClaudeConfigInput,
    historyName?: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    if (input.protocol !== 'openai') {
      return {
        historyMetadata: {
          ...(historyName ? { name: historyName } : {}),
          protocol: input.protocol ?? defaultConnectionProtocolForPreset(input.preset),
        },
        input,
      };
    }

    const prepared = await this.prepareOpenAiConnection(input, assertCurrent);
    assertCurrent();
    return {
      historyMetadata: {
        ...prepared.historyMetadata,
        ...(historyName ? { name: historyName } : {}),
      },
      input: prepared.effectiveInput,
      presentation: prepared.presentation,
    };
  }

  /** Reads and prepares one history replay without changing the project profile. */
  public async prepareConnectionHistory(
    cwd: string,
    entryId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    const replay = this.historyStore.toReplayInput(cwd, entryId);
    assertCurrent();
    if (replay.config.protocol === 'openai') {
      return this.prepareConnectionConfig(replay.config, replay.name, assertCurrent);
    }
    return {
      historyMetadata: {
        name: replay.name,
        protocol: replay.protocol,
      },
      input: replay.config,
    };
  }

  /** The only project-route persistence point; callers hold the directory transaction here. */
  public commitPreparedConfig(cwd: string, prepared: PreparedClaudeConfigSave): void {
    this.configStore.save(cwd, prepared.input, prepared.presentation);
  }

  /** Performs fallible post-commit work while the caller still owns the tentative profile. */
  public async completePreparedConfigSave(
    sessionId: string,
    cwd: string,
    prepared: PreparedClaudeConfigSave,
  ): Promise<ClaudeProjectState> {
    await this.recordConnectionHistory(cwd, prepared.input, prepared.historyMetadata);
    const runtime = this.ensureSession(sessionId, cwd);
    if (!runtime.active) {
      await this.prepareRouteServices(
        this.routeKindForConfig(this.configStore.getConfig(cwd)),
        sessionId,
      );
    }
    return this.publishProjectState(sessionId, cwd);
  }

  public getConnectionHistory(cwd: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.list(cwd);
  }

  public deleteConnectionHistory(cwd: string, entryId: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.remove(cwd, entryId);
  }

  public renameConnectionHistory(
    cwd: string,
    entryId: string,
    name: string,
  ): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.rename(cwd, entryId, name);
  }

  /** Builds the real Claude Code route for an OpenAI-compatible upstream. */
  private async prepareOpenAiConnection(
    input: SaveClaudeConfigInput,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedOpenAiConnection> {
    if (input.authMode !== 'authToken' && input.authMode !== 'none') {
      throw new Error('OpenAI 协议请选择 Bearer 密钥或无需认证。');
    }
    const model = input.model.trim();
    const modelFast = input.modelFast?.trim() || model;
    if (!MODEL_NAME_PATTERN.test(model) || !MODEL_NAME_PATTERN.test(modelFast)) {
      throw new Error('模型标识只能包含字母、数字以及 . _ : / @ [ ] ~ -。');
    }
    const endpoint = completeConnectionEndpoint(input.baseUrl, 'openai');
    const protocol = routerProtocolForOpenAiEndpoint(endpoint);

    let routerState = await this.routerManager.getState();
    assertCurrent();
    if (!routerState.installed) {
      const installed = await this.routerManager.installFromNpm('npm');
      assertCurrent();
      routerState = installed.state;
      this.softwareUpdatesCache.clear();
    }
    if (!routerState.managementAvailable) {
      let startError: unknown;
      try {
        routerState = await this.routerManager.start();
      } catch (error) {
        startError = error;
        routerState = await this.routerManager.getState();
      }
      assertCurrent();
      if (!routerState.managementAvailable) {
        throw new Error(
          startError instanceof Error
            ? `OpenAI 协议需要本地 Router 完成格式转换：${startError.message}`
            : 'OpenAI 协议需要先安装并启动本地 Router。',
        );
      }
    }

    const sameEndpoint = (candidate: ClaudeRouterManagementState['providers'][number]): boolean => {
      if (candidate.protocol !== protocol) {
        return false;
      }
      try {
        return completeConnectionEndpoint(candidate.baseUrl, 'openai') === endpoint;
      } catch {
        return false;
      }
    };
    const existing =
      routerState.providers.find((candidate) => candidate.id === input.routerProviderId) ??
      routerState.providers.find(sameEndpoint);
    const enteredCredential = input.credential?.trim();
    const credentialAction =
      input.authMode === 'none' || input.credentialAction === 'clear'
        ? 'clear'
        : enteredCredential
          ? 'replace'
          : 'keep';
    if (
      credentialAction === 'keep' &&
      input.authMode !== 'none' &&
      !existing?.credentialConfigured
    ) {
      throw new Error('这个 OpenAI 中转站还没有保存接口密钥，请填写后再继续。');
    }

    const saved = await this.routerManager.saveProvider({
      apiKey: enteredCredential,
      baseUrl: endpoint,
      credentialAction,
      id: existing?.id,
      makePreferred: true,
      models: [...new Set([model, modelFast])],
      name: existing?.name ?? customRouterProviderName(endpoint),
      protocol,
      useForCurrentProject: false,
    });
    assertCurrent();
    routerState = await this.routerManager.start();
    assertCurrent();
    this.routerHealthCache.set(routerState);
    if (routerState.gatewayState !== 'running') {
      throw new Error(`本地 Router 未能启动模型网关：${routerState.message}`);
    }

    const sourceCredentialConfigured =
      credentialAction === 'replace' ||
      (credentialAction === 'keep' && Boolean(existing?.credentialConfigured));
    const sourceConfig: SaveClaudeConfigInput = {
      ...input,
      baseUrl: endpoint,
      credential: undefined,
      credentialAction: 'keep',
      protocol: 'openai',
      routerProviderId: saved.provider.id,
    };
    return {
      effectiveInput: {
        apiKeyHelperPolicy: input.apiKeyHelperPolicy,
        authMode: 'authToken',
        baseUrl: saved.connection.baseUrl,
        credential: saved.connection.apiKey,
        credentialAction: 'replace',
        model: `${saved.provider.name}/${model}`,
        modelFast: `${saved.provider.name}/${modelFast}`,
        preset: 'custom',
        provider: 'gateway',
      },
      historyMetadata: {
        name: saved.provider.name,
        protocol: 'openai',
        routerProviderId: saved.provider.id,
        sourceConfig,
        sourceCredential: credentialAction === 'replace' ? enteredCredential : undefined,
        sourceCredentialConfigured,
      },
      presentation: {
        protocol: 'openai',
        routerProviderId: saved.provider.id,
        sourceAuthMode: input.authMode,
        sourceBaseUrl: endpoint,
        sourceCredentialConfigured,
        sourceModel: model,
        sourceModelFast: modelFast,
      },
    };
  }

  private async recordConnectionHistory(
    cwd: string,
    input: SaveClaudeConfigInput,
    metadata?: ConnectionHistoryMetadata,
  ): Promise<void> {
    try {
      const router = await this.getRouterHealthState();
      this.historyStore.record(cwd, {
        config: input,
        credential: metadata?.sourceConfig
          ? metadata.sourceCredential
          : this.configStore.getCredential(cwd),
        gatewayEndpoint: router.endpoint,
        gatewayState: router.gatewayState,
        name: metadata?.name,
        protocol: metadata?.protocol ?? defaultConnectionProtocolForPreset(input.preset),
        routerProviderId: metadata?.routerProviderId,
        sourceConfig: metadata?.sourceConfig,
        sourceCredentialConfigured: metadata?.sourceCredentialConfigured,
      });
    } catch {
      // The configuration is already saved; a missing history entry is not worth failing over.
    }
  }

  public async testConnection(
    cwd: string,
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    const prepared =
      input.protocol === 'openai' ? await this.prepareOpenAiConnection(input) : undefined;
    const testInput = prepared?.effectiveInput ?? input;
    const config = normalizeClaudeConfig(testInput);
    const enteredCredential = testInput.credential?.trim();
    const credential = enteredCredential || this.configStore.getCredential(cwd);
    const fingerprint = connectionFingerprint(config, credential);
    const result = await this.backgroundTasks.run(
      `connection-test:${projectKey(cwd)}:${fingerprint}`,
      'interactive',
      () => testClaudeConnection(config, credential),
    );
    this.connectionChecks.set(projectKey(cwd), {
      fingerprint,
      result,
    });
    return result;
  }
}
