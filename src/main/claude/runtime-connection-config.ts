import { createHmac, randomBytes } from 'node:crypto';
import { modelUsageConnection, type ModelUsageObserver } from '../usage/identity';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ClaudeConfigView,
  ClaudeConnectionHistoryEntry,
  ClaudeConnectionTestResult,
  ClaudeEndpointProtocol,
  ClaudeNextConversationConnectionState,
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
import { resolveAutomaticClaudeConnection } from './automatic-connection';
import type { ClaudeConfigSnapshot, ClaudeLaunchConfigSnapshot } from './config-store';
import {
  ClaudeConnectionHistoryStore,
  type ClaudeConnectionHistorySnapshot,
  type ConnectionHistoryReplay,
} from './connection-history';
import {
  MODEL_NAME_PATTERN,
  type NormalizedClaudeConfig,
  normalizeClaudeConfig,
} from './configuration';
import {
  connectionFingerprint,
  customRouterProviderName,
  defaultConnectionProtocolForPreset,
  projectKey,
} from './runtime-connection';
import { ClaudeRuntimeRouting } from './runtime-routing';
import { claudeOfficialAuthProvider } from './official-auth-status';
import { sanitizeAccountIdentity } from '../../shared/claude/account-identity';
import {
  isSubscriptionBaseUrl,
  isSubscriptionProvider,
  SUBSCRIPTION_UPSTREAM_URLS,
} from '../../shared/claude/subscriptions';
import {
  captureClaudeNetworkAccess,
  type ClaudeLaunchAuthorization,
  type ClaudeNetworkAccess,
  type ConnectionCheckRecord,
  type ConnectionHistoryMetadata,
  type PreparedClaudeConfigSave,
  type PreparedOpenAiConnection,
  type RuntimeSession,
  sameClaudeNetworkAccess,
} from './runtime-types';

export interface ClaudeConnectionHistoryAuthorization {
  readonly cwdKey: string;
  readonly entryId: string;
  readonly networkAccess?: Readonly<ClaudeNetworkAccess>;
  readonly officialNetworkProvider?: NetworkProviderId;
  readonly replay: ConnectionHistoryReplay;
}

/** Credential-free process-local identity safe to retain while renderer input is pending. */
export interface ClaudeLaunchConfigurationBaseline {
  readonly cwdKey: string;
  readonly networkAccess?: Readonly<ClaudeNetworkAccess>;
  readonly revision: string;
  readonly officialNetworkProvider?: NetworkProviderId;
}

/** Credential-free process-local identity for one exact connection-history entry. */
export interface ClaudeConnectionHistoryBaseline {
  readonly cwdKey: string;
  readonly entryId: string;
  readonly networkAccess?: Readonly<ClaudeNetworkAccess>;
  readonly revision: string;
  readonly officialNetworkProvider?: NetworkProviderId;
}

export interface ClaudeRuntimeConfigTransactionSnapshot {
  config: ClaudeConfigSnapshot;
  history: ClaudeConnectionHistorySnapshot;
}

export const claudeNetworkAccessForConfig = (
  config: Pick<NormalizedClaudeConfig, 'baseUrl' | 'preset'>,
  protocol: ClaudeEndpointProtocol | undefined,
): Readonly<ClaudeNetworkAccess> | undefined => {
  const officialNetworkProvider = officialNetworkProviderForClaudePreset(config.preset);
  if (officialNetworkProvider) {
    return captureClaudeNetworkAccess({ provider: officialNetworkProvider });
  }
  if (protocol === 'openai' || !config.baseUrl.trim()) return undefined;
  const baseUrl =
    isSubscriptionProvider(config.preset) && isSubscriptionBaseUrl(config.baseUrl)
      ? SUBSCRIPTION_UPSTREAM_URLS[config.preset]
      : config.baseUrl;
  return captureClaudeNetworkAccess({
    provider: 'anthropic-claude',
    target: {
      process: 'claude-cli',
      url: completeConnectionEndpoint(baseUrl, 'anthropic'),
    },
  });
};

export const claudeNetworkAccessForConfigInput = (
  input: SaveClaudeConfigInput,
): Readonly<ClaudeNetworkAccess> | undefined => {
  const officialNetworkProvider = officialNetworkProviderForClaudePreset(input.preset);
  if (officialNetworkProvider) {
    return captureClaudeNetworkAccess({ provider: officialNetworkProvider });
  }
  if (input.protocol === 'openai') return undefined;
  return claudeNetworkAccessForConfig(
    normalizeClaudeConfig(input),
    input.protocol ?? defaultConnectionProtocolForPreset(input.preset),
  );
};

export const claudeNetworkAccessForLaunchSnapshot = (
  snapshot: Pick<ClaudeLaunchConfigSnapshot, 'config' | 'protocol'>,
): Readonly<ClaudeNetworkAccess> | undefined =>
  claudeNetworkAccessForConfig(snapshot.config, snapshot.protocol);

export const resolveSessionConnectionConfigScope = (
  runtime: { connectionConfigScope?: (sessionId: string, cwd: string) => string },
  sessionId: string,
  cwd: string,
): string => runtime.connectionConfigScope?.call(runtime, sessionId, cwd) ?? cwd;

export abstract class ClaudeRuntimeConnectionConfig extends ClaudeRuntimeRouting {
  protected modelUsageObserver?: ModelUsageObserver;

  public setModelUsageObserver(observer: ModelUsageObserver): void {
    this.modelUsageObserver = observer;
    this.notifyModelUsageConnection(false);
  }

  private notifyModelUsageConnection(reset: boolean): void {
    if (!this.modelUsageObserver) return;
    try {
      this.modelUsageObserver.select(
        this.hasNextConversationConnection()
          ? modelUsageConnection(
              this.configStore.createLaunchSnapshot(this.nextConversationConfigScope),
            )
          : undefined,
        reset,
      );
    } catch {
      /* Optional usage observers never participate in the configuration transaction. */
    }
  }
  private readonly connectionChecks = new Map<string, ConnectionCheckRecord>();
  private readonly conversationConfigScopes = new Map<string, string>();
  private readonly historyStore: ClaudeConnectionHistoryStore;
  private readonly launchBaselineKey = randomBytes(32);
  private nextConversationConfigQueue: Promise<void> = Promise.resolve();
  private nextConversationMutationCount = 0;
  private nextConversationReservation: symbol | undefined;
  private subscriptionAccountIdentity: (config: ClaudeConfigView) => string | undefined = () =>
    undefined;

  public setSubscriptionAccountIdentityResolver(
    resolve: (config: ClaudeConfigView) => string | undefined,
  ): void {
    this.subscriptionAccountIdentity = resolve;
  }

  protected constructor(
    userDataPath: string,
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
    this.historyStore = new ClaudeConnectionHistoryStore(userDataPath);
  }

  /** Reserves the entire login/test/save transaction, including time spent in a browser. */
  public reserveNextConversationConnection(): { token: symbol; release: () => void } {
    if (this.nextConversationReservation || this.nextConversationMutationCount) {
      throw new Error('已有接入操作正在进行，请稍候。');
    }
    const token = Symbol('subscription-connection');
    this.nextConversationReservation = token;
    return {
      token,
      release: () => {
        if (this.nextConversationReservation === token)
          this.nextConversationReservation = undefined;
      },
    };
  }

  private assertNextConversationReservation(token?: symbol): void {
    if (this.nextConversationReservation !== token) {
      throw new Error('已有订阅接入正在进行，请先完成或取消。');
    }
  }

  private enqueueNextConversationConfig<T>(
    operation: () => Promise<T>,
    token?: symbol,
  ): Promise<T> {
    try {
      this.assertNextConversationReservation(token);
    } catch (error) {
      return Promise.reject(error);
    }
    this.nextConversationMutationCount += 1;
    const guarded = async (): Promise<T> => {
      this.assertNextConversationReservation(token);
      return operation();
    };
    const queued = this.nextConversationConfigQueue.then(guarded, guarded).finally(() => {
      this.nextConversationMutationCount -= 1;
    });
    this.nextConversationConfigQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private conversationScope(sessionId: string): string {
    return path.join(this.conversationConfigScopeRoot, sessionId);
  }

  /** Returns the main-only profile owned by this conversation, falling back for legacy sessions. */
  public connectionConfigScope(sessionId: string, cwd: string): string {
    return this.conversationConfigScopes?.get(sessionId) ?? cwd;
  }

  public hasNextConversationConnection(): boolean {
    return this.configStore.has(this.nextConversationConfigScope);
  }

  public async getNextConversationConnection(): Promise<ClaudeNextConversationConnectionState> {
    if (!this.hasNextConversationConnection()) return {};
    const config = this.configStore.getView(this.nextConversationConfigScope);
    const accountIdentity = isSubscriptionProvider(config.preset)
      ? sanitizeAccountIdentity(this.subscriptionAccountIdentity(config))
      : undefined;
    const officialAuth =
      config.preset === 'anthropic' ? await claudeOfficialAuthProvider.getState() : undefined;
    return {
      config,
      ...(accountIdentity ? { accountIdentity } : {}),
      ...(officialAuth ? { officialAuth } : {}),
    };
  }

  /** Main-only stable identity used to authorize work against the global next-conversation profile. */
  public nextConversationConnectionScope(): string {
    return this.nextConversationConfigScope;
  }

  /** Captures the global choice atomically for one newly-created conversation. */
  public bindNextConversationConnection(sessionId: string, cwd: string): void {
    if (!this.hasNextConversationConnection()) {
      throw new Error('尚未选择下个对话接入，请先在“模型”页面选择平台和模型。');
    }
    const scope = this.conversationScope(sessionId);
    this.configStore.copyConnection(
      this.nextConversationConfigScope,
      scope,
      this.configStore.getAllowBypassPermissions(cwd),
    );
    this.conversationConfigScopes.set(sessionId, scope);
  }

  /** Gives a restored conversation an isolated baseline before its remembered binding is applied. */
  public bindProjectConversationConnection(sessionId: string, cwd: string): void {
    const scope = this.conversationScope(sessionId);
    const source = this.hasNextConversationConnection() ? this.nextConversationConfigScope : cwd;
    this.configStore.copyConnection(source, scope, this.configStore.getAllowBypassPermissions(cwd));
    this.conversationConfigScopes.set(sessionId, scope);
  }

  public releaseConversationConnection(sessionId: string): void {
    const scope = this.conversationConfigScopes.get(sessionId);
    if (!scope) return;
    this.conversationConfigScopes.delete(sessionId);
    this.configStore.remove(scope);
  }

  public clearNextConversationConnection(): void {
    this.assertNextConversationReservation();
    if (this.nextConversationMutationCount) throw new Error('已有接入操作正在进行。');
    this.configStore.remove(this.nextConversationConfigScope);
    this.notifyModelUsageConnection(true);
  }

  /** Promotes an isolated restored session only after its full transaction has committed. */
  public promoteConversationConnectionToNext(sessionId: string, cwd: string): void {
    this.assertNextConversationReservation();
    if (this.nextConversationMutationCount) throw new Error('已有接入操作正在进行。');
    this.configStore.copyConnection(
      this.connectionConfigScope(sessionId, cwd),
      this.nextConversationConfigScope,
    );
    this.notifyModelUsageConnection(false);
  }

  public saveNextConversationConfig(
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeNextConversationConnectionState> {
    return this.enqueueNextConversationConfig(async () => {
      const snapshot = this.configStore.createSnapshot(this.nextConversationConfigScope);
      let prepared: PreparedClaudeConfigSave | undefined;
      try {
        prepared = await this.prepareConnectionConfig(input);
        this.commitPreparedConfig(this.nextConversationConfigScope, prepared);
        const state = await this.getNextConversationConnection();
        this.notifyModelUsageConnection(true);
        return state;
      } catch (error) {
        this.configStore.restoreSnapshot(this.nextConversationConfigScope, snapshot);
        if (prepared) {
          try {
            await this.rollbackPreparedConfig(prepared);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              '下个对话接入保存失败，且外部路由回滚未完整完成。',
              { cause: rollbackError },
            );
          }
        }
        throw error;
      }
    });
  }

  public testNextConversationConnection(
    input: SaveClaudeConfigInput,
  ): Promise<ClaudeConnectionTestResult> {
    return this.enqueueNextConversationConfig(async () => {
      const prepared = await this.prepareConnectionConfig(input);
      try {
        return await this.testPreparedConnection(this.nextConversationConfigScope, prepared);
      } finally {
        await this.rollbackPreparedConfig(prepared);
      }
    });
  }

  /** One serialized test-and-commit transaction used by the managed ChatGPT flow. */
  public verifyAndSaveNextConversationConfig(
    input: SaveClaudeConfigInput,
    retryBeforeSecondAttempt?: () => Promise<void>,
    options: {
      automaticFetch?: typeof fetch;
      testOnly?: boolean;
      reservation?: symbol;
      signal?: AbortSignal;
      beforeCommit?: () => void;
    } = {},
  ): Promise<{
    connectionTest: ClaudeConnectionTestResult;
    state: ClaudeNextConversationConnectionState;
  }> {
    return this.enqueueNextConversationConfig(async () => {
      const assertCurrent = (): void => {
        options.signal?.throwIfAborted();
        this.assertNextConversationReservation(options.reservation);
      };
      assertCurrent();
      const snapshot = this.configStore.createSnapshot(this.nextConversationConfigScope);
      let prepared: PreparedClaudeConfigSave | undefined;
      try {
        if (input.autoDetect && !options.automaticFetch) {
          throw new Error('自动接入缺少网络授权。');
        }
        const automatic =
          input.autoDetect && options.automaticFetch
            ? await resolveAutomaticClaudeConnection(
                input,
                this.configStore,
                this.nextConversationConfigScope,
                options.automaticFetch,
              )
            : undefined;
        prepared = await this.prepareConnectionConfig(automatic?.input ?? input);
        assertCurrent();
        let connectionTest =
          automatic?.input.protocol === 'anthropic'
            ? automatic.test
            : await this.testPreparedConnection(
                this.nextConversationConfigScope,
                prepared,
                assertCurrent,
                options.signal,
              );
        assertCurrent();
        if (
          !connectionTest.ok &&
          retryBeforeSecondAttempt &&
          (connectionTest.failureKind === 'network' || connectionTest.failureKind === 'timeout')
        ) {
          await retryBeforeSecondAttempt();
          assertCurrent();
          connectionTest = await this.testPreparedConnection(
            this.nextConversationConfigScope,
            prepared,
            assertCurrent,
            options.signal,
          );
        }
        if (!connectionTest.ok || options.testOnly) {
          const rejected = prepared;
          prepared = undefined;
          await this.rollbackPreparedConfig(rejected);
          return {
            connectionTest,
            state: await this.getNextConversationConnection(),
          };
        }
        assertCurrent();
        options.beforeCommit?.();
        this.commitPreparedConfig(this.nextConversationConfigScope, prepared);
        const state = await this.getNextConversationConnection();
        this.notifyModelUsageConnection(true);
        return {
          connectionTest,
          state,
        };
      } catch (error) {
        this.configStore.restoreSnapshot(this.nextConversationConfigScope, snapshot);
        if (prepared) {
          try {
            await this.rollbackPreparedConfig(prepared);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              '下个对话接入验证失败，且外部路由回滚未完整完成。',
              { cause: rollbackError },
            );
          }
        }
        throw error;
      }
    }, options.reservation);
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

  public networkAccess(cwd: string): Readonly<ClaudeNetworkAccess> | undefined {
    return claudeNetworkAccessForConfig(
      this.configStore.getConfig(cwd),
      this.configStore.getView(cwd).protocol,
    );
  }

  public networkAccessForConfigInput(
    input: SaveClaudeConfigInput,
  ): Readonly<ClaudeNetworkAccess> | undefined {
    return claudeNetworkAccessForConfigInput(input);
  }

  public officialNetworkProvider(cwd: string): NetworkProviderId | undefined {
    return officialNetworkProviderForClaudePreset(this.configStore.getConfig(cwd).preset);
  }

  public captureLaunchAuthorization(cwd: string, sessionId?: string): ClaudeLaunchAuthorization {
    const configScope = sessionId ? this.connectionConfigScope(sessionId, cwd) : cwd;
    const launchSnapshot = this.configStore.createLaunchSnapshot(configScope);
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(
      launchSnapshot.config.preset,
    );
    const networkAccess = claudeNetworkAccessForLaunchSnapshot(launchSnapshot);
    return Object.freeze({
      cwdKey: projectKey(configScope),
      launchSnapshot,
      ...(networkAccess === undefined ? {} : { networkAccess }),
      ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
    });
  }

  public assertLaunchAuthorizationCurrent(
    cwd: string,
    authorization: ClaudeLaunchAuthorization,
    sessionId?: string,
  ): void {
    const configScope = sessionId ? this.connectionConfigScope(sessionId, cwd) : cwd;
    if (
      authorization.cwdKey !== projectKey(configScope) ||
      !this.configStore.launchSnapshotIsCurrent(configScope, authorization.launchSnapshot)
    ) {
      throw new Error('Claude 接入配置在授权期间已更新，本次启动已取消，请重试。');
    }
  }

  public captureLaunchConfigurationBaseline(
    cwd: string,
    sessionId?: string,
  ): ClaudeLaunchConfigurationBaseline {
    const configScope = sessionId ? this.connectionConfigScope(sessionId, cwd) : cwd;
    const snapshot = this.configStore.createSnapshot(configScope);
    const config = this.configStore.getConfig(configScope);
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(config.preset);
    const networkAccess = claudeNetworkAccessForConfig(
      config,
      this.configStore.getView(configScope).protocol,
    );
    return Object.freeze({
      cwdKey: projectKey(configScope),
      ...(networkAccess === undefined ? {} : { networkAccess }),
      revision: this.baselineRevision(snapshot),
      ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
    });
  }

  public assertLaunchConfigurationBaselineCurrent(
    cwd: string,
    baseline: ClaudeLaunchConfigurationBaseline,
    sessionId?: string,
  ): void {
    const current = this.captureLaunchConfigurationBaseline(cwd, sessionId);
    if (
      current.cwdKey !== baseline.cwdKey ||
      current.revision !== baseline.revision ||
      !sameClaudeNetworkAccess(current.networkAccess, baseline.networkAccess) ||
      current.officialNetworkProvider !== baseline.officialNetworkProvider
    ) {
      throw new Error('Claude 接入配置在等待确认期间已更新，本次启动已失效。');
    }
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

  public connectionHistoryNetworkAccess(
    cwd: string,
    entryId: string,
  ): Readonly<ClaudeNetworkAccess> | undefined {
    return this.networkAccessForConfigInput(this.historyStore.toSaveInput(cwd, entryId));
  }

  public captureConnectionHistoryAuthorization(
    cwd: string,
    entryId: string,
  ): ClaudeConnectionHistoryAuthorization {
    const replay = structuredClone(this.historyStore.toReplayInput(cwd, entryId));
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(replay.config.preset);
    const networkAccess = this.networkAccessForConfigInput(replay.config);
    return Object.freeze({
      cwdKey: projectKey(cwd),
      entryId,
      ...(networkAccess === undefined ? {} : { networkAccess }),
      ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
      replay,
    });
  }

  public assertConnectionHistoryAuthorizationCurrent(
    cwd: string,
    authorization: ClaudeConnectionHistoryAuthorization,
  ): void {
    if (
      authorization.cwdKey !== projectKey(cwd) ||
      !isDeepStrictEqual(
        this.historyStore.toReplayInput(cwd, authorization.entryId),
        authorization.replay,
      )
    ) {
      throw new Error('历史接入在授权或事务等待期间已更新，请重试。');
    }
  }

  public captureConnectionHistoryBaseline(
    cwd: string,
    entryId: string,
  ): ClaudeConnectionHistoryBaseline {
    const replay = this.historyStore.toReplayInput(cwd, entryId);
    const officialNetworkProvider = officialNetworkProviderForClaudePreset(replay.config.preset);
    const networkAccess = this.networkAccessForConfigInput(replay.config);
    return Object.freeze({
      cwdKey: projectKey(cwd),
      entryId,
      ...(networkAccess === undefined ? {} : { networkAccess }),
      revision: this.baselineRevision(replay),
      ...(officialNetworkProvider === undefined ? {} : { officialNetworkProvider }),
    });
  }

  public assertConnectionHistoryBaselineCurrent(
    cwd: string,
    baseline: ClaudeConnectionHistoryBaseline,
  ): void {
    const current = this.captureConnectionHistoryBaseline(cwd, baseline.entryId);
    if (
      current.cwdKey !== baseline.cwdKey ||
      current.entryId !== baseline.entryId ||
      current.revision !== baseline.revision ||
      !sameClaudeNetworkAccess(current.networkAccess, baseline.networkAccess) ||
      current.officialNetworkProvider !== baseline.officialNetworkProvider
    ) {
      throw new Error('历史接入在等待确认期间已更新，本次启动已失效。');
    }
  }

  public createConfigSnapshot(cwd: string): ClaudeRuntimeConfigTransactionSnapshot {
    return {
      config: this.configStore.createSnapshot(cwd),
      history: this.historyStore.createSnapshot(),
    };
  }

  public restoreConfigSnapshot(
    cwd: string,
    snapshot: ClaudeRuntimeConfigTransactionSnapshot,
  ): void {
    this.configStore.restoreSnapshot(cwd, snapshot.config);
    this.historyStore.restoreSnapshot(snapshot.history);
  }

  public mergeConfigCompletionSnapshot(
    committed: ClaudeRuntimeConfigTransactionSnapshot,
    completed: ClaudeRuntimeConfigTransactionSnapshot,
  ): ClaudeRuntimeConfigTransactionSnapshot {
    return {
      config: committed.config,
      history: completed.history,
    };
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

    const openAiPrepared = await this.prepareOpenAiConnection(input, assertCurrent);
    const prepared: PreparedClaudeConfigSave = {
      historyMetadata: {
        ...openAiPrepared.historyMetadata,
        ...(historyName ? { name: historyName } : {}),
      },
      input: openAiPrepared.effectiveInput,
      presentation: openAiPrepared.presentation,
      rollbackRouterConfig: openAiPrepared.rollbackRouterConfig,
    };
    try {
      assertCurrent();
      return prepared;
    } catch (error) {
      return this.failAfterPreparedConfig(prepared, error);
    }
  }

  /** Reads and prepares one history replay without changing the project profile. */
  public async prepareConnectionHistory(
    cwd: string,
    entryId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    const replay = this.historyStore.toReplayInput(cwd, entryId);
    assertCurrent();
    return this.prepareConnectionReplay(replay, assertCurrent);
  }

  public async prepareAuthorizedConnectionHistory(
    cwd: string,
    authorization: ClaudeConnectionHistoryAuthorization,
    assertCurrent: () => void = () => undefined,
  ): Promise<PreparedClaudeConfigSave> {
    this.assertConnectionHistoryAuthorizationCurrent(cwd, authorization);
    assertCurrent();
    const prepared = await this.prepareConnectionReplay(
      structuredClone(authorization.replay),
      assertCurrent,
    );
    try {
      assertCurrent();
      this.assertConnectionHistoryAuthorizationCurrent(cwd, authorization);
      const preparedNetworkAccess = claudeNetworkAccessForConfig(
        normalizeClaudeConfig(prepared.input),
        prepared.presentation?.protocol ??
          prepared.input.protocol ??
          defaultConnectionProtocolForPreset(prepared.input.preset),
      );
      if (
        officialNetworkProviderForClaudePreset(prepared.input.preset) !==
          authorization.officialNetworkProvider ||
        !sameClaudeNetworkAccess(preparedNetworkAccess, authorization.networkAccess)
      ) {
        throw new Error('历史接入准备结果与已授权网络目标不一致，请重试。');
      }
      return prepared;
    } catch (error) {
      return this.failAfterPreparedConfig(prepared, error);
    }
  }

  private prepareConnectionReplay(
    replay: ConnectionHistoryReplay,
    assertCurrent: () => void,
  ): Promise<PreparedClaudeConfigSave> | PreparedClaudeConfigSave {
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
  public commitPreparedConfig(
    cwd: string,
    prepared: PreparedClaudeConfigSave,
    sessionId?: string,
  ): void {
    this.configStore.save(
      sessionId ? this.connectionConfigScope(sessionId, cwd) : cwd,
      prepared.input,
      prepared.presentation,
    );
  }

  /** Performs fallible post-commit work while the caller still owns the tentative profile. */
  public async completePreparedConfigSave(
    sessionId: string,
    cwd: string,
    prepared: PreparedClaudeConfigSave,
  ): Promise<ClaudeProjectState> {
    await this.recordConnectionHistory(cwd, prepared.input, prepared.historyMetadata);
    const runtime = this.ensureSession(sessionId, cwd);
    const configScope = this.connectionConfigScope(sessionId, cwd);
    if (!runtime.active) {
      await this.prepareRouteServices(
        this.routeKindForConfig(this.configStore.getConfig(configScope)),
        sessionId,
        cwd,
      );
    }
    return this.publishProjectState(sessionId, cwd);
  }

  public getConnectionHistory(cwd: string): ClaudeConnectionHistoryEntry[] {
    return this.historyStore.list(cwd);
  }

  protected conversationReplayForCurrent(cwd: string): ConnectionHistoryReplay | undefined {
    return this.historyStore.findReplayForCurrent(cwd, this.configStore.getView(cwd));
  }

  protected conversationReplayForView(
    cwd: string,
    view: ClaudeConfigView,
  ): ConnectionHistoryReplay | undefined {
    return this.historyStore.findReplayForCurrent(cwd, view);
  }

  protected conversationReplayForModel(
    cwd: string,
    model: string,
  ): ConnectionHistoryReplay | undefined {
    return this.historyStore.findReplayForModel(cwd, model);
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
    try {
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
          preset: input.preset,
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
          sourceCredential: credentialAction === 'replace' ? enteredCredential : undefined,
          sourceCredentialConfigured,
          sourceModel: model,
          sourceModelFast: modelFast,
        },
        rollbackRouterConfig: saved.rollbackConfigMutation,
      };
    } catch (error) {
      return this.failAfterSavedRouterMutation(saved, error);
    }
  }

  private baselineRevision(value: unknown): string {
    return createHmac('sha256', this.launchBaselineKey)
      .update(JSON.stringify(value))
      .digest('base64url');
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

  /** Tests the exact effective route prepared for a history replay before its profile is committed. */
  public async testPreparedConnection(
    cwd: string,
    prepared: PreparedClaudeConfigSave,
    assertCurrent: () => void = () => undefined,
    signal?: AbortSignal,
    configScope = cwd,
  ): Promise<ClaudeConnectionTestResult> {
    assertCurrent();
    const config = normalizeClaudeConfig(prepared.input);
    const enteredCredential = prepared.input.credential?.trim();
    const credential = enteredCredential || this.configStore.getCredential(configScope);
    const fingerprint = connectionFingerprint(config, credential);
    const routeKind = this.routeKindForConfig(config);
    const ownerId = `connection-test:${projectKey(configScope)}:${randomBytes(8).toString('hex')}`;
    const reservation = this.routeLifecycle.reserve(ownerId, routeKind);
    try {
      const routeStarted = await this.prepareRouteServices(routeKind, ownerId, cwd);
      if (routeStarted && !prepared.rollbackRouteServices) {
        prepared.rollbackRouteServices = () => this.stopUnusedRoute(routeKind);
      }
      assertCurrent();
      const result = await testClaudeConnection(config, credential, signal);
      assertCurrent();
      this.connectionChecks.set(projectKey(configScope), { fingerprint, result });
      return result;
    } finally {
      this.routeLifecycle.release(reservation);
    }
  }
}
